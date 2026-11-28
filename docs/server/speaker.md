# A Squirmy speaker

Squirmy speaker turns a Raspberry Pi, or any Linux computer with a sound card, into a playback device. It shows up in every Squirmy app's device list, like a phone or a browser tab. Pick it, and your session plays there, through the DAC or amplifier it is wired to. The apps stay the remote: play, pause, seek, skip, volume and the queue all work as they do for any other device.

It has no screen. It plays only what the session sends it, and the [signal path](./playback.md#seeing-what-plays) in Now Playing shows what it receives.

## What you need

- A Raspberry Pi 3 or newer (or any 64-bit or 32-bit ARM or x86 Linux computer) with a sound card: the Pi's own headphone jack, a USB DAC, or a DAC HAT such as a HiFiBerry or an IQaudio.
- `ffmpeg` and `aplay` (from `alsa-utils`), or `pacat` (from `pulseaudio-utils`) on a computer that runs PulseAudio or PipeWire. The Docker image has all three.
- Node.js 22.13 or newer, when you install without Docker.
- A Squirmy server running this version or a newer one. Older servers can't pair speakers.

## Install with Docker

From a clone of the repository on the speaker computer:

```sh
git clone https://github.com/IsaacThoman/squirmy.git && cd squirmy
SQUIRMY_SPEAKER_NAME="Living room" docker compose -f apps/speaker/compose.yaml up -d --build
docker compose -f apps/speaker/compose.yaml logs -f
```

The compose file passes the sound card in (`--device /dev/snd`) and uses the host's network, which mDNS and the status page need. To build the image elsewhere for a Pi, run `docker buildx build --platform linux/arm64 -f apps/speaker/Dockerfile -t squirmy-speaker .` from the repository root. The sign-in is kept in the `speaker_data` volume.

## Install with systemd

```sh
sudo apt install nodejs npm ffmpeg alsa-utils
sudo git clone https://github.com/IsaacThoman/squirmy.git /opt/squirmy && cd /opt/squirmy
sudo npm ci --ignore-scripts -w @squirmy/contracts -w @squirmy/client-core -w @squirmy/speaker
sudo npm run build:packages && sudo npm run build:speaker
sudo cp apps/speaker/deploy/squirmy-speaker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now squirmy-speaker
journalctl -u squirmy-speaker -f
```

Edit the unit's `Environment=` lines for the name, the server and the output device before you start it. The unit runs the speaker as an unprivileged user in the `audio` group and keeps its sign-in in `/var/lib/squirmy-speaker`. To try it without installing, `npm run dev:speaker` from the repository root runs it in the terminal.

## Pairing

The first time it starts, the speaker finds the server (the one in `SQUIRMY_SERVER`, else the first one advertised on the LAN when the server has [LAN discovery](./authentication.md#lan-discovery) on) and shows an eight-character code, a link and a QR code in its log. It also shows them on its status page, at `http://<speaker address>:4790`.

Approve it from any device signed in to Squirmy:

- **Web:** **Settings → Security → Add a speaker**, then enter the code. Or open the link, or scan the QR code with a phone.
- **iOS:** **Account → Sign in a TV…**, then enter the code.

Check that the code matches before you approve: approving signs the speaker in to your account. It appears in **Settings → Security → Where you're signed in** as a Squirmy speaker, where you can sign it out. A code lasts ten minutes; the speaker shows a new one when it expires. Pairing works as [Apple TV pairing](./authentication.md#apple-tv-pairing) does, with the same limits.

A speaker that is signed out (from that list, or because the account's password changed) goes back to showing a code. To forget the sign-in on the speaker itself, run `squirmy-speaker unpair` (in Docker: `docker compose -f apps/speaker/compose.yaml run --rm speaker node apps/speaker/dist/main.js unpair`).

## Settings

Everything is set with environment variables. None is required.

| Variable | Default | What it does |
|---|---|---|
| `SQUIRMY_SERVER` | the paired server, else found on the LAN | The server's address, such as `http://music.local:4747` or `https://music.example.com`. |
| `SQUIRMY_SPEAKER_NAME` | `Speaker (<hostname>)` | The name in device lists. |
| `SQUIRMY_SPEAKER_OUTPUT` | `alsa` | `alsa` plays through `aplay`, `pulse` through `pacat` (PulseAudio, or PipeWire with `pipewire-pulse`), `null` discards the sound, for trying it out. |
| `SQUIRMY_SPEAKER_DEVICE` | the system default | The ALSA device (`hw:CARD=DAC,DEV=0`, `plughw:1,0`) or the PulseAudio sink name. |
| `SQUIRMY_SPEAKER_RATE` | `source` | `source` plays each song at its own sample rate. A number, such as `48000`, resamples everything to it. |
| `SQUIRMY_SPEAKER_MAX_RATE` | `192000` | The highest rate the DAC takes. Faster songs are resampled to the highest rate of their own family under it (176.4 kHz becomes 88.2 kHz with `96000`). |
| `SQUIRMY_SPEAKER_FORMAT` | `s32` | Samples as 32-bit (`s32`) or 16-bit (`s16`) integers. Use `s16` for a `hw:` device that only takes 16-bit. |
| `SQUIRMY_SPEAKER_MIXER` | none | An ALSA mixer control (`PCM`, `Digital`, `Master`) to turn for volume. See [Volume](#volume). |
| `SQUIRMY_SPEAKER_MIXER_CARD` | the default card | The card that control is on, such as `1` or `DAC`. |
| `SQUIRMY_SPEAKER_QUALITY` | your Wi-Fi quality setting | `original`, `high` or `data_saver`. |
| `SQUIRMY_SPEAKER_BUFFER_MS` | `300` | How far ahead of the speakers sound is written. Raise it if a busy computer stutters. Pause and skip react within this long. |
| `SQUIRMY_SPEAKER_STATUS_PORT` | `4790` | The status page's port. `0` turns the page and the mDNS advertisement off. |
| `SQUIRMY_SPEAKER_MDNS` | `true` | Find servers, and advertise the speaker as `_squirmy-speaker._tcp`, on the LAN. |
| `SQUIRMY_SPEAKER_STATE_DIR` | `~/.local/state/squirmy-speaker` | Where the device id and sign-in are kept (`/data` in Docker; systemd's `StateDirectory`). |
| `FFMPEG_PATH` | `ffmpeg` | The ffmpeg to decode with. |

## Picking the output device

`aplay -l` lists the sound cards and `aplay -L` the device names. Some common ones:

- `default`: whatever the system's default is. On Raspberry Pi OS with PipeWire, that is PipeWire, which mixes and resamples.
- `hw:CARD=DAC,DEV=0` (or `hw:1,0`): the card directly. Nothing else can play while the speaker has it open, and the card must take the song's rate and format.
- `plughw:CARD=DAC,DEV=0`: the card, with ALSA converting what it cannot take.

On a computer running PulseAudio or PipeWire, either use `SQUIRMY_SPEAKER_OUTPUT=pulse` (and `pactl list short sinks` for the sink names) or stop the sound server from holding the card. The speaker reopens a card that goes away (a USB DAC unplugged, or busy) every two seconds, and carries on where it was.

## Bit-perfect playback

The speaker gets the original file when it can decode it (FLAC, ALAC, WAV, AIFF, MP3, AAC, Opus and Vorbis), and FLAC in fragmented MP4 for any other lossless file, at **Original** quality. It decodes with ffmpeg and plays at the file's own sample rate. Samples reach the card untouched when all of these hold:

- the output device is a `hw:` device that takes the song's rate (up to `SQUIRMY_SPEAKER_MAX_RATE`) and 32-bit samples, or 16-bit with `SQUIRMY_SPEAKER_FORMAT=s16` for 16-bit songs;
- `SQUIRMY_SPEAKER_RATE` is `source`;
- **Volume normalization** is off (**Settings → Playback**), and the volume is at 100% or turned by a [mixer control](#volume).

Sixteen- and 24-bit songs are sent as 32-bit samples, shifted up without changing them; the DAC ignores the extra low bits. Through `default`, `plughw:` or PulseAudio, the sound server may resample or mix.

## Gapless playback

Songs play back to back as one continuous stream: the next song's samples follow the last sample of the one before, with nothing added or lost, using the [exact lengths and priming](./playback.md#fragmented-mp4) the server measured. When two songs in a row have different sample rates, the speaker reopens the card at the new rate, which leaves a short gap. To avoid it, set `SQUIRMY_SPEAKER_RATE` to one rate. A song started by hand (a skip, a seek, a pick from the queue) fades in over 5 ms, so it doesn't click.

## Volume

The session's volume for the speaker (the slider in the apps) scales the samples by default. Normalization, when it is on, does too. The speaker has no limiter, so normalization only turns songs down, never up past their peak.

With `SQUIRMY_SPEAKER_MIXER` set, the volume turns that ALSA control instead (with `amixer`, mapped to how loud it sounds), and the samples are only scaled by normalization. Use this for a DAC with a hardware volume, such as a HAT's `Digital` control. `amixer -c <card> scontrols` lists a card's controls.

## Troubleshooting

- **It doesn't appear in the device list.** Check the log for `Connected to …`. A speaker that cannot reach the server says why and keeps trying. Devices appear only while they are connected.
- **No sound.** Try `speaker-test -D <device> -c 2 -t sine` with the same device, and check the card's volume in `alsamixer`. A `Device or resource busy` in the log means something else has the card: use `default`, `pulse`, or stop the other program.
- **Stutters.** Raise `SQUIRMY_SPEAKER_BUFFER_MS`, or set the quality to **High** on a slow network. The apps show the speaker as buffering while it waits for the network.
- **The status page or mDNS doesn't work in Docker.** Both need `network_mode: host`, which the compose file sets. mDNS also needs a network that passes multicast.
