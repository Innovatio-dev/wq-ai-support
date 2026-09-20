---
title: "Turn on two-factor authentication (2FA)"
category: "Manage your account"
subcategory: "Security"
summary: "Add a second login step with an authenticator app or SMS in Profile settings → Security, and save your backup codes."
aliases:
  - "2FA"
  - "two step verification"
  - "authenticator app"
  - "security code"
  - "backup codes"
  - "MFA"
related:
  - "[[account/security/lost-2fa-device]]"
  - "[[safety-privacy/suspicious-login-hacked-account]]"
  - "[[account/logging-in/reset-or-change-password]]"
escalate_if:
  - "setup QR code fails to verify after checking phone time settings"
  - "member did not turn on 2FA but is being asked for a code"
cta:
  label: "Turn on 2FA"
  url: "/backoffice/settings/security"
updated: 2026-09-15
---

# Turn on two-factor authentication (2FA)

Two-factor authentication asks for a one-time code after your password, so a stolen password alone can't open your account. We strongly recommend it for everyone, especially once you have earnings in your Wallet.

## Set up 2FA with an authenticator app (recommended)

1. Install an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.
2. In the Back Office, go to **Profile settings → Security**.
3. Under **Two-factor authentication**, select **Turn on**.
4. Choose **Authenticator app** and scan the QR code with the app.
5. Enter the 6-digit code the app shows and select **Verify**.
6. **Save your 10 backup codes** somewhere safe (download or print them). Each works once.

## Set up 2FA by SMS

Choose **Text message** in step 4. We send codes to the verified mobile number on your account. SMS is less secure than an app but better than no 2FA.

## Using 2FA

After your password (or Google sign-in), enter the current code. Tick **Trust this device for 30 days** on your own computer to be asked less often.

## Turn off 2FA

Go to **Profile settings → Security → Two-factor authentication → Turn off**. You'll need your password and a current code.

## Related articles

- [[account/security/lost-2fa-device]]
- [[safety-privacy/suspicious-login-hacked-account]]
- [[account/logging-in/reset-or-change-password]]
