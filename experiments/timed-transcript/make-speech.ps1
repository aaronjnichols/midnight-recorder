param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
public class TimedSpeechWord {
    public string text;
    public double start;
}
public class TimedSpeechFixture {
    public static List<TimedSpeechWord> Save(string text, string file) {
        var words = new List<TimedSpeechWord>();
        using (var voice = new SpeechSynthesizer()) {
            voice.SelectVoice("Microsoft Zira Desktop");
            voice.Rate = 0;
            voice.SetOutputToWaveFile(file, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            voice.SpeakProgress += (sender, e) => words.Add(new TimedSpeechWord {text=e.Text, start=e.AudioPosition.TotalSeconds});
            voice.Speak(text);
        }
        return words;
    }
}
'@
$cues = @(
    @{ start=1.0; text='Open the settings panel.' },
    @{ start=7.0; text='Keep autosave off while you change the project name.' },
    @{ start=14.0; text='Select the Save button on the left.' },
    @{ start=21.0; text='Do not select Cancel. We need to keep these changes.' },
    @{ start=29.0; text='The Save button is now on the right. Select it to finish.' },
    @{ start=38.0; text='Set the level to fifteen, not fifty.' },
    @{ start=46.0; text='Set Mannings n to zero point zero three five.' }
)
$index=0
foreach ($cue in $cues) {
    $index++
    $file=Join-Path $OutputDirectory "cue-$index.wav"
    $words=[TimedSpeechFixture]::Save($cue.text, $file)
    $cue.file=$file
    $cue.words=@($words | ForEach-Object { @{text=$_.text; start=$_.start + $cue.start} })
}
@{voice='Microsoft Zira Desktop'; duration=54; cues=$cues; timingReference='SAPI SpeakProgress events. These are synthesis timing references, not manually measured phonetic boundaries.'} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'reference.json') -Encoding utf8
