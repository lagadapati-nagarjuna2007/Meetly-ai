# Meetly AI -- Meeting Security Module Master Prompt (Template)

> **Note:** The complete specification is larger than a single chat
> response.

## Goal

Implement a production-ready **Meeting Security Module** for Meetly AI
without modifying or breaking existing functionality.

## Scope

-   Browser Fingerprint
-   Auto Admit (ON/OFF)
-   Waiting Room
-   Accept / Reject
-   Ban Device (only after participant has joined)
-   Socket.IO
-   LiveKit
-   Meeting-scoped device bans
-   Automatic cleanup
-   Security, performance, test cases

## Core Flow

``` text
Join Meeting
    ↓
Generate Browser Fingerprint
    ↓
Backend checks meeting_device_bans
    ↓
Blocked?
 ┌───────────────┐
 │ Yes     No    │
 ▼         ▼
Reject   Auto Admit?
             │
      ┌──────┴──────┐
      │             │
     ON            OFF
      │             │
      ▼             ▼
Join      Waiting Room
                │
          ✔ Accept
          ✖ Reject
                │
                ▼
         Participant Joins
                │
      🎤 Mute / 👢 Remove / 🚫 Ban Device
```

## Rules

-   Generate browser fingerprint only when Join Meeting is clicked.
-   No LiveKit token before host approval.
-   Ban Device only after participant joins.
-   Meeting-scoped bans only.
-   Cleanup bans when meeting ends.
