English | [中文](https://github.com/610la/dsh-notification-center/blob/main/README.md)

# DSH Notification Center

A **notification center** for DSH: when a conversation or task finishes, it pops a **browser system notification** and plays a **sound alert** — so you never miss a completed task, even in another window.

## Features

- 🔔 **Browser system notifications** + **sound alerts** (21 built-in sounds, all replaceable)
- 🎚️ **Per-event configuration**: notification toggle, sound type, custom sound file/URL, volume
- 🚫 Manual stop/interrupt of generation is **silent by default**; errors, token limits and blocks are notified
- ⏰ Instant alert when the model requests **approval** (not subject to cooldown)
- 💾 Settings are auto-saved and survive page refreshes

## Installation

One command (recommended):

```bash
dsh plugin --profile web add @lyhalal/dsh-notification-center
```

Restart DSH and the browser side loads automatically — no extra configuration.

> Manual equivalent: run `npm install @lyhalal/dsh-notification-center` in the DSH project,
> then add the following to the `plugins` list of the host `cordis.yml`:
> ```yaml
> plugins:
>   - from: '@lyhalal/dsh-notification-center'
> ```

## Usage

- **🔔 on the input bar**: quick toggles for "Browser notifications / Completion sounds", grant notification permission, and run a test
- **Settings → Notification Center**: full configuration
  - **Master switches**: browser notifications, completion sounds, notification permission, notification test, cooldown interval
  - **Events**: conversation done, subtask done, workflow done, background job done, approval pending
  - **Stop reasons**: error, max tokens exceeded, blocked, other, manual stop/interrupt
- Expand any category to configure: **sound type** (21 built-in / silent / custom file / custom URL), **volume**, **toggle** — the selected sound plays immediately for preview

## Notes

- On first use, **allow browser notification permission**: click "Grant" or "Test" and accept the browser prompt
- Sounds play only after **at least one click on the page** (browser autoplay policy)
- Manual stop/interrupt is **silent by default**; enable it under "Stop reasons → Manual stop/interrupt" if you want it

## Uninstall

```bash
dsh plugin --profile web remove @lyhalal/dsh-notification-center
```

## Links

- npm: https://www.npmjs.com/package/@lyhalal/dsh-notification-center
- GitHub: https://github.com/610la/dsh-notification-center
