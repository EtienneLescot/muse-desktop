# Privacy policy — Desktop for Muse Code (Muse-Desktop)

Last updated: 15 October 2026.

Desktop for Muse Code is an independent, open-source desktop app for the Muse Code coding agent. It
is published by Etienne Lescot. It is not made, endorsed or supported by Meta.

## What the app collects

**Nothing.** The app has no account, no telemetry, no analytics and no crash reporting. Its
publisher receives no data from it.

## What stays on your computer

Conversations, project settings, drafts, notifications and scheduled runs are stored locally, in the
app's data folder (`%APPDATA%\com.muse.desktop` on Windows, `~/Library/Application Support/com.muse.desktop`
on macOS). Uninstalling the app and deleting that folder removes them. Secrets you enter, such as a
remote MCP token, are kept in the operating system's credential store.

## What leaves your computer, and only because you asked

- **The Muse Code engine.** The app drives the Muse Code engine, which sends your prompts, the files
  and command output it works on, and your account credentials to Meta's service. That processing
  is governed by Meta's own terms and privacy policy, not by this one.
- **Services you configure.** A remote MCP server, an SSH host, a share server you run yourself, or
  a Git remote you push to receive what you send them, under their own terms.
- **Installers you start.** Installing the Muse Code CLI or the computer-use driver from Settings
  downloads them from their publishers (dev.meta.ai, cua.ai).
- **The built-in browser** loads the pages you or the agent open, like any browser.

## Computer use, browser and microphone

Computer use, attaching your own browser and voice input are off until you turn them on. With
computer use on, the screenshots and page contents the agent reads go to the Muse Code engine like
any other tool output; the app keeps no recording of your screen. Voice input uses the
operating system's speech recognition, which may send the audio to Microsoft or Apple to transcribe
it, under their privacy policies; the app keeps only the resulting text in your draft.

## Children

The app is a developer tool and is not directed at children.

## Changes and contact

Changes to this policy are published in this file, with its history in the repository. Questions:
open an issue at https://github.com/EtienneLescot/muse-desktop/issues.
