let recorder,
  streams = [],
  audioContext,
  frame,
  queue = Promise.resolve(),
  chunkError,
  inputEnded = false,
  endNotified = false;

function addInput(stream) {
  streams.push(stream);
  if (stream.getTracks().some((track) => track.readyState === "ended"))
    throw new Error("A recording input ended before startup completed.");
  stream.getTracks().forEach((track) =>
    track.addEventListener(
      "ended",
      () => {
        inputEnded = true;
        if (recorder && recorder.state !== "inactive" && !endNotified) {
          endNotified = true;
          window.captureBridge.ended();
        }
      },
      { once: true },
    ),
  );
}

async function cleanup() {
  clearInterval(frame);
  streams.forEach((stream) =>
    stream.getTracks().forEach((track) => track.stop()),
  );
  streams = [];
  if (audioContext) await audioContext.close();
  audioContext = null;
  document
    .querySelectorAll("video,canvas")
    .forEach((element) => element.remove());
}

async function videoElement(stream) {
  const element = document.createElement("video");
  element.muted = true;
  element.srcObject = stream;
  document.body.append(element);
  await element.play();
  return element;
}

async function start(options) {
  queue = Promise.resolve();
  chunkError = null;
  inputEnded = false;
  endNotified = false;
  let screenStream, cameraStream;
  const fps = options.frameRate || 30;
  try {
    if (!options.cameraOnly || options.systemAudio) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: !!options.systemAudio,
      });
      addInput(screenStream);
      if (options.systemAudio && !screenStream.getAudioTracks().length)
        throw new Error(
          "System audio is not available. Check the Windows audio output or turn off System audio.",
        );
    }
    if (options.cameraId || options.cameraOnly) {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video:
          options.cameraId && options.cameraId !== "default"
            ? { deviceId: { exact: options.cameraId } }
            : true,
        audio: false,
      });
      addInput(cameraStream);
    }
    const output = new MediaStream();
    {
      const visibleScreen = options.cameraOnly ? null : screenStream;
      const screen = await videoElement(visibleScreen || cameraStream);
      const camera =
        visibleScreen && cameraStream ? await videoElement(cameraStream) : null;
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      canvas.width = screen.videoWidth;
      canvas.height = screen.videoHeight;
      const context = canvas.getContext("2d");
      const draw = () => {
        context.drawImage(screen, 0, 0, canvas.width, canvas.height);
        if (camera) {
          const radius = Math.min(canvas.width, canvas.height) * 0.13;
          const x = canvas.width - radius - 24,
            y = canvas.height - radius - 24;
          context.save();
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.clip();
          const side = Math.min(camera.videoWidth, camera.videoHeight);
          context.drawImage(
            camera,
            (camera.videoWidth - side) / 2,
            (camera.videoHeight - side) / 2,
            side,
            side,
            x - radius,
            y - radius,
            radius * 2,
            radius * 2,
          );
          context.restore();
        }
      };
      draw();
      frame = setInterval(draw, 1000 / fps);
      const composed = canvas.captureStream(fps);
      addInput(composed);
      output.addTrack(composed.getVideoTracks()[0]);
    }
    if (options.microphoneId) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio:
          options.microphoneId === "default"
            ? true
            : { deviceId: { exact: options.microphoneId } },
        video: false,
      });
      addInput(mic);
    }
    const audioStreams = streams.filter(
      (stream) => stream.getAudioTracks().length,
    );
    if (audioStreams.length) {
      audioContext = new AudioContext();
      await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      audioStreams.forEach((stream) =>
        audioContext.createMediaStreamSource(stream).connect(destination),
      );
      output.addTrack(destination.stream.getAudioTracks()[0]);
    }
    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (inputEnded)
      throw new Error("A recording input ended before startup completed.");
    recorder = new MediaRecorder(output, {
      mimeType,
      videoBitsPerSecond: 6000000,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size)
        queue = queue
          .then(async () =>
            window.captureBridge.chunk(await event.data.arrayBuffer()),
          )
          .catch((error) => {
            chunkError = error;
          });
    };
    recorder.start(1000);
    return { mimeType };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function stop() {
  if (recorder && recorder.state !== "inactive") {
    await new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) =>
        reject(new Error(event.error?.message || "Recording failed."));
      recorder.stop();
    });
  }
  await queue;
  await cleanup();
  if (chunkError) throw chunkError;
  return {};
}

window.captureBridge.listen(async ({ id, action, args }) => {
  try {
    let result = {};
    if (action === "devices")
      result = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => ["audioinput", "videoinput"].includes(d.kind))
        .map((d) => ({
          id: d.deviceId,
          kind: d.kind,
          name: d.label || (d.kind === "audioinput" ? "Microphone" : "Camera"),
        }));
    if (action === "start") result = await start(args);
    if (action === "pause") recorder.pause();
    if (action === "resume") recorder.resume();
    if (action === "stop") result = await stop();
    if (action === "cancel") {
      try {
        await stop();
      } catch {
        /* Cancel must release a failed recording. */
      }
      await cleanup();
      recorder = null;
      chunkError = null;
      queue = Promise.resolve();
    }
    window.captureBridge.reply({ id, result });
  } catch (error) {
    window.captureBridge.reply({ id, error: error.message });
  }
});
