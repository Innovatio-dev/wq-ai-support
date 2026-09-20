---
title: "Lost your phone or 2FA device"
category: "Manage your account"
subcategory: "Security"
summary: "Log in with a backup code if you lose your 2FA device, then set up 2FA again; without codes, support must verify you."
aliases:
  - "new phone 2FA"
  - "lost authenticator"
  - "can't get 2FA code"
  - "backup code"
  - "reset two factor"
related:
  - "[[account/security/two-factor-authentication]]"
  - "[[account/logging-in/cant-log-in]]"
  - "[[device-troubleshooting/manage-devices]]"
escalate_if:
  - "member has no backup codes and no access to the 2FA device or SMS number"
  - "member thinks the lost phone was stolen and is still logged in"
cta:
  label: "Security settings"
  url: "/backoffice/settings/security"
updated: 2026-09-15
---

# Lost your phone or 2FA device

## If you have a backup code

1. On the login page, enter your email and password (or use Google).
2. On the code screen, select **Use a backup code**.
3. Enter one of your saved backup codes. Each code works once.
4. Go to **Profile settings → Security** and select **Reset two-factor authentication**.
5. Set up your new phone and **save the new backup codes**. The old ones stop working.

## If you changed phones but still have the old one

Most authenticator apps can transfer accounts to a new phone. Otherwise, log in using the old phone, then reset 2FA as in step 4 above.

## If you have no backup codes

Open a ticket on the WealthQuest Support site under **Login → 2FA recovery**. For your protection we must confirm your identity before removing 2FA; this may include a fresh identity check. Allow up to 24 hours for our first reply.

## If your phone was stolen

1. From another device, log in and go to **Profile settings → Devices**.
2. Select **Log out of all devices**.
3. Change your password.
4. Reset 2FA as above.

## Related articles

- [[account/security/two-factor-authentication]]
- [[account/logging-in/cant-log-in]]
- [[device-troubleshooting/manage-devices]]
