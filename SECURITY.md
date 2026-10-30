# Security policy

## Supported versions

Only the `main` branch is maintained, and only the live part of it: the n8n workflow
in `booking_bot/`. `supabase/`, `webui/` and `python_version/` are retired and kept
for reference.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/a-3isa/hostel-bookings-bot/security/advisories/new)).

Please do not open a public issue for a security problem, and do not test against the
live bot or its Google Sheet: they hold real bookings.

Include what you can of:
- the file, workflow node or bot flow affected;
- steps to reproduce, or a proof of concept;
- the impact you expect.

I aim to acknowledge reports within a week. Once an issue is confirmed, a fix is
prepared on a private branch and you are credited in the advisory unless you prefer not to be.

## Scope

In scope: the code in this repository.

Out of scope: Telegram, Google Sheets, n8n and Anthropic themselves, and findings that
need a staff member's Telegram account or the n8n instance's credentials.
