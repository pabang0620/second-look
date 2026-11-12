#!/usr/bin/env python3
"""Approves one PayPal sandbox order as the sandbox buyer (headless Chromium). Used by scripts/recordSandboxRun.js.

Usage: python3 scripts/sandboxApprove.py <approval url>
Credentials come from SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD in the environment only (the buyer pool
wrapper sets them), never from the command line. It only approves; the app authorizes, captures or voids.
Exit 0 when PayPal sends the browser back to the app's return URL, 2 otherwise (a screenshot is saved).
"""
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')

if len(sys.argv) != 2 or not sys.argv[1].startswith('https://www.sandbox.paypal.com/'):
    sys.exit('Usage: python3 scripts/sandboxApprove.py <sandbox approval url>')
EMAIL = os.environ.get('SANDBOX_BUYER_EMAIL', '')
PASSWORD = os.environ.get('SANDBOX_BUYER_PASSWORD', '')
if not EMAIL or not PASSWORD:
    sys.exit('Set SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD in the environment.')

returned = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=EXE if os.path.exists(EXE) else None)
    page = browser.new_page()
    page.on('request', lambda r: returned.append(r.url) if '/api/paypal/return' in r.url else None)
    ok = False
    try:
        page.goto(sys.argv[1], wait_until='domcontentloaded')
        email = page.locator('#email')
        if email.is_visible(timeout=10000):
            email.fill(EMAIL)
            if page.locator('#btnNext').is_visible():
                page.locator('#btnNext').click()
            page.locator('#password').fill(PASSWORD)
            page.locator('#btnLogin').click()
        button = page.locator("button#payment-submit-btn, button[data-id='payment-submit-btn'], button:has-text('Complete Purchase'), button:has-text('Pay Now'), button:has-text('Continue')").first
        button.wait_for(timeout=40000)
        button.click()
        for _ in range(90):
            if returned or re.search(r'/api/paypal/return', page.url):
                ok = True
                break
            page.wait_for_timeout(500)
    except PlaywrightTimeout:
        ok = bool(returned)
    if not ok:
        (ROOT / '.scratch').mkdir(exist_ok=True)
        page.screenshot(path=str(ROOT / '.scratch' / 'sandbox-approve.png'))
    browser.close()
print('approved' if ok else 'NOT approved')
sys.exit(0 if ok else 2)
