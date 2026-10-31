import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, stat, copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function run(executable, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { windowsHide: true });
    let output = '', error = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { error = (error + chunk).slice(-12000); });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || `${executable} exited with code ${code}.`)));
  });
}

export class Media {
  constructor({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) { this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; }
  async probe(file) {
    const info = JSON.parse(await run(this.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
    const video = info.streams.find(s => s.codec_type === 'video');
    if (!video) throw new Error('The file has no video track.');
    let seconds = Number(info.format.duration || video.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const scan = await run(this.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-', '-progress', 'pipe:1']);
      const values = [...scan.matchAll(/out_time_us=(\d+)/g)];
      seconds = Number(values.at(-1)?.[1]) / 1e6;
    }
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Cannot read video duration.');
    return { duration: seconds, width: video.width, height: video.height, hasAudio: info.streams.some(s => s.codec_type === 'audio') };
  }
  async export(video, output) {
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Export path must end with .mp4.');
    try { await stat(output); throw new Error('Export file already exists. Select a new path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    const temporary = path.join(path.dirname(path.resolve(output)), `.midnight-${randomUUID()}.mp4`);
    const { segments, speed, muted } = video.timeline;
    const audio = video.metadata.hasAudio && !muted;
    const filters = [], labels = [];
    segments.forEach((s, index) => {
      filters.push(`[0:v]fps=30,trim=start=${s.start}:end=${s.end},setpts=(PTS-STARTPTS)/${speed},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[v${index}]`);
      labels.push(`[v${index}]`);
      if (audio) {
        filters.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,atempo=${speed}[a${index}]`);
        labels.push(`[a${index}]`);
      }
    });
    filters.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=${audio ? 1 : 0}[v]${audio ? '[a]' : ''}`);
    const args = ['-v', 'error', '-n', '-i', video.path, '-filter_complex', filters.join(';'), '-map', '[v]'];
    if (audio) args.push('-map', '[a]', '-c:a', 'aac');
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary);
    try {
      await run(this.ffmpeg, args);
      const metadata = await this.probe(temporary);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: path.resolve(output), metadata };
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
