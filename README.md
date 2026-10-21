# slapmod

Slap your MacBook and Claude feels it. slapmod is a free, open-source mod for Claude Code that reads your MacBook's built-in motion sensor, so when you smack the laptop it goes bonk, a little meter in the side panel jumps, and if Claude was halfway through doing something you didn't like, the slap stops it and Claude gets told on your next message that you slapped it.

It runs in Claude Code, in the terminal and in the Code tab of the Claude desktop app. It doesn't run in Claude's chat or Cowork, because mods are a Claude Code feature, and it needs an Apple Silicon MacBook (M1 or later), because desktop Macs don't have a motion sensor.

## Install

At the Claude Code prompt in a terminal:

```
/plugin install slapmod --marketplace tonnoz/slapmod
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install slapmod --marketplace tonnoz/slapmod
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `tonnoz/slapmod`, then Add plugin.

There's no sudo and no permission prompt, since the sensor is read as a normal user.

## Install with an agent

Paste this into Claude Code, or any coding agent that can run commands on your Mac:

```text
Install the slapmod plugin for Claude Code on this Mac.

1. Check this Mac can run it: `uname -m` must print arm64, and `pmset -g batt` must mention InternalBattery, because slapmod needs an Apple Silicon MacBook (desktop Macs have no motion sensor). If either check fails, stop and tell me why.
2. Check Claude Code is installed with `claude --version`. If the command isn't found, stop and tell me to install the plugin from the Claude desktop app instead: + next to the prompt box, then Plugins, Add marketplace with tonnoz/slapmod, then Add plugin.
3. Run `claude plugin install slapmod --marketplace tonnoz/slapmod`. It adds the tonnoz/slapmod marketplace to my user settings and installs slapmod for my user. Don't use sudo.
4. Run `claude plugin list` and confirm slapmod is listed and enabled.
5. Tell me to run /reload-plugins (or start a new Claude Code session), then slap the laptop and type /slap to open the motion meter.
```

## Using it

Slap the laptop. The status line keeps count, and a toast tells you how hard it was. Type `/slap` to open the panel with the live motion meter, your slap count for this session and of all time, and a button to test the sound. `/slap` again closes it, and `/slap test` plays the sound without the panel.

A few things to try:

1. Ask Claude for something big, and when it starts going the wrong way, slap the laptop. The turn stops, and your next message reaches Claude with a note saying you slapped it, so it knows to change course.
2. Open `/slap` and tap the desk, type hard, close the lid halfway, and watch what the meter picks up.
3. Set On slap to `tell` in `/config`, slap a few times while Claude works, and see how Claude takes it in its next reply.

## Settings

Change these in `/config`:

| Setting | Choices | What it does |
| --- | --- | --- |
| On slap | `stop` (default), `tell`, `off` | `stop` ends Claude's running turn and tells Claude why with your next message. `tell` lets the turn run and just mentions the slaps next time. `off` keeps it to sounds and the meter. |
| Sound | `bonk` (default), `voice`, `off` | A cartoon bonk that gets meaner the harder you hit, or your Mac's own voice saying ouch, or nothing. |
| Sensitivity | `low`, `medium` (default), `high` | How hard a slap has to be. Go `low` if bumping the desk counts, `high` if gentle taps don't. |

If you have a few Claude sessions open, they all count the slap but only one of them plays the sound, so you don't get a choir. In `stop` mode, though, a slap stops every session that's in the middle of a turn, because it has no way to know which Claude you're mad at.

## What it runs, stores and sends

Everything slapmod does on your Mac, so there are no surprises:

- **Runs** `native/slapsense`, the motion helper built from the Swift source in `helper/`, from the moment a Claude Code session starts until it ends. It reads the accelerometer and prints slap events, and it exits when Claude Code does.
- **Runs** `/usr/bin/pgrep -x slapmac` every 30 seconds, to see whether SlapMac is running (when it is, slapmod stays quiet so you don't hear two sounds).
- **Runs** `/bin/chmod +x` on the helper once, only if an install dropped its executable bit and the helper couldn't start.
- **Plays sounds** through Claude Code's sound support, which uses macOS `afplay` for the bonks and `say` for the voice option.
- **Stores** your all-time slap count in Claude Code's own plugin storage, and a small lock file, `slapmod-sound.lock`, in your user's temp folder, so only one session plays sounds.
- **Tells Claude** one line per message at most, and only in `stop` or `tell` mode: a note added to your next message, such as "the user slapped their MacBook 2 times since your last message, the hardest a solid one".
- **Sends nothing.** slapmod makes no network requests, the motion data never leaves your Mac, and it reads nothing from your conversations.

## Made by the SlapMac dev

slapmod comes from the developer of [SlapMac](https://slapmac.com), the Mac app that talks back when you slap it. If SlapMac is running, slapmod stays quiet and lets it play the sounds, and the meter, the count and the Claude stuff keep working as before.

## How it works

The helper opens the accelerometer through IOKit HID, filters out gravity, finds slaps and prints one JSON line per event, and the mod reads those lines, draws the panel and plays the sounds. The binary in `native/` is built from `helper/` by `Scripts/build-helper.sh`, signed with a Developer ID and notarized by Apple, so you can read every line that goes into it.

## Building it yourself

- The helper: `swift test --package-path helper` runs the detector tests, and `Scripts/build-helper.sh` builds `native/slapsense`. It signs ad hoc unless you copy `.env.example` to `.env.local` and fill in your own Developer ID identity and notarytool profile.
- The mod: run `claude --plugin-dir .` from the repo once so Claude Code lays the API types in `.claude-plugin/types/`, then `pnpm install`, `pnpm typecheck`, `pnpm test` and `pnpm validate`.
- The sounds are synthesized by `python3 Scripts/make-sounds.py`, so the repo owns every clip.

Mods are early access in Claude Code and the API moves between releases. This one was built and tested on Claude Code 2.1.306.

## Support

Found a bug, or slapmod counts slaps you didn't make? [Open an issue](https://github.com/tonnoz/slapmod/issues) and say which Mac you have and what the meter showed. For a security problem, report it privately through the repository's Security tab instead.

## Credits

The original slap-your-laptop idea is [spank](https://github.com/taigrr/spank) by taigrr, and reading the Apple Silicon accelerometer comes from taigrr's [apple-silicon-accelerometer](https://github.com/taigrr/apple-silicon-accelerometer) work.

MIT licensed, see [LICENSE](LICENSE).
