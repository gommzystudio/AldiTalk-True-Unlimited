import puppeteer, { Browser, Page } from 'puppeteer';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { userInfo } from 'os';
import { parse as parseEnv } from 'dotenv';

/**
 * ALDI TALK re-booking helper.
 *
 * Tarif L gives 100 GB Inland data and, once fewer than 1 GB is left, a free
 * "1 GB nachbuchen" button that may be pressed as often as you like. This
 * script watches the counter and presses that button for you.
 *
 * Fixes over the original script:
 *  1. `USERNAME` in .env never reached the login form: dotenv does not override
 *     real environment variables, and $USERNAME is the OS account name. The
 *     .env file is now parsed directly and dedicated names are preferred.
 *  2. The login fields live inside novum <one-input> shadow roots.
 *     ElementHandle.$() does not cross shadow boundaries, so `host >>> input`
 *     is required; the old aria selectors matched the wrapper element.
 *  3. The Usercentrics consent dialog covers the usage meter and silently
 *     swallows coordinate clicks. It is dismissed before any interaction.
 *  4. Fixed sleeps replaced with event/selector waits, the booking request is
 *     awaited and verified, and nothing is logged as "success" unchecked.
 */

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
const fileVars: Record<string, string> = (() => {
  for (const candidate of [join(ROOT, '.env'), join(process.cwd(), '.env')]) {
    if (existsSync(candidate)) return parseEnv(readFileSync(candidate));
  }
  return {};
})();

const pick = (...values: Array<string | undefined>): string | undefined =>
  values.find(v => typeof v === 'string' && v.trim().length > 0)?.trim();

const USERNAME = pick(process.env.ALDITALK_USERNAME, fileVars.ALDITALK_USERNAME, fileVars.USERNAME);
const PASSWORD = pick(process.env.ALDITALK_PASSWORD, fileVars.ALDITALK_PASSWORD, fileVars.PASSWORD);

if (!USERNAME || !PASSWORD) {
  console.error('No credentials found. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (USERNAME === userInfo().username) {
  console.error(
    `Refusing to start: the username resolved to the OS account "${USERNAME}".\n` +
      'That happens when $USERNAME leaks in - use ALDITALK_USERNAME instead.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const readString = (key: string): string | undefined =>
  pick(process.env[key], fileVars[key]);

const readNumber = (key: string, fallback: number): number => {
  const raw = readString(key);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const findChrome = (): string | undefined => {
  const explicit = readString('CHROME_PATH');
  if (explicit) return explicit;
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].find(existsSync);
};

const CFG = {
  portalUrl: 'https://www.alditalk-kundenportal.de/portal/auth/uebersicht/',
  intervalMs: Math.max(1, readNumber('CHECK_INTERVAL_MINUTES', 5)) * 60_000,
  /**
   * Book another GB once remaining data reaches this level. The portal itself
   * only accepts a re-booking below 1 GB and silently ignores the click above
   * that, so the threshold is clamped to 1 GB.
   */
  thresholdMb: Math.min(1024, Math.max(64, readNumber('TOPUP_THRESHOLD_MB', 1024))),
  headless: readString('HEADLESS') !== 'false',
  profileDir: readString('PROFILE_DIR') ?? join(ROOT, '.chrome-profile'),
  chromePath: findChrome(),
  once: process.argv.includes('--once'),
  dryRun: process.argv.includes('--dry-run'),
  navTimeout: 60_000,
  renderTimeout: 30_000,
} as const;

const SEL = {
  loginUserHost: '#idToken3_od',
  loginPassHost: '#idToken4_od',
  meter: 'one-usage-meter',
  actionButton: 'one-button[slot="action"]',
  consentAccept: '[data-testid="uc-accept-all-button"]',
} as const;

// ---------------------------------------------------------------------------
// Logging / loop control
// ---------------------------------------------------------------------------
const mask = (value: string): string =>
  value.length <= 5 ? '***' : `${value.slice(0, 3)}****${value.slice(-3)}`;

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let stopping = false;

const interruptibleSleep = (ms: number): Promise<void> =>
  new Promise(resolveSleep => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (stopping || Date.now() >= deadline) return resolveSleep();
      setTimeout(tick, Math.min(1_000, deadline - Date.now()));
    };
    setTimeout(tick, Math.min(1_000, ms));
  });

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
const hasSelector = async (page: Page, selector: string, timeout = 5_000): Promise<boolean> => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

const normalise = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();

/** Click the first match in the composed tree, crossing open shadow roots. */
const deepClick = (page: Page, selector: string): Promise<{ clicked: boolean; text?: string }> =>
  page.evaluate((sel: string) => {
    const hits: Element[] = [];
    const walk = (root: Document | ShadowRoot): void => {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (element.matches(sel)) hits.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    const target = hits.find(element => element.getClientRects().length > 0) ?? hits[0];
    if (!target) return { clicked: false };
    (target as HTMLElement).click();
    return { clicked: true, text: (target.textContent ?? '').trim().slice(0, 40) };
  }, selector);

const isConsentVisible = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const walk = (root: Document | ShadowRoot): boolean => {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        const shadow = element.shadowRoot;
        if (!shadow) continue;
        if (shadow.querySelector('[data-testid="uc-accept-all-button"]')) return true;
        if (walk(shadow)) return true;
      }
      return false;
    };
    return walk(document);
  });

/**
 * The consent dialog overlays the usage meter. A click sent to the element's
 * coordinates lands on the overlay and the app never sees it, so accept first.
 */
const dismissConsent = async (page: Page): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await isConsentVisible(page))) return;
    const result = await deepClick(page, SEL.consentAccept);
    log(
      result.clicked
        ? `Dismissed the cookie consent dialog ("${result.text}")`
        : 'Cookie consent is visible but the accept button was not clickable'
    );
    await sleep(1_500);
  }
};

/** Set a novum <one-input> value so its internal state and hidden form field sync. */
const setNovumValue = (page: Page, hostSelector: string, value: string): Promise<string> =>
  page.evaluate(
    (selector: string, next: string) => {
      const input = document.querySelector(selector)?.shadowRoot?.querySelector('input');
      if (!input) throw new Error(`No input found inside ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Native input value setter unavailable');
      setter.call(input, next);
      for (const type of ['input', 'change', 'blur']) {
        input.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      }
      return input.value;
    },
    hostSelector,
    value
  );

/** Wait until the novum component has actually rendered its inner <input>. */
const hasLoginForm = async (page: Page, timeout = 20_000): Promise<boolean> => {
  try {
    await page.waitForFunction(
      (selector: string) => !!document.querySelector(selector)?.shadowRoot?.querySelector('input'),
      { timeout },
      SEL.loginUserHost
    );
    return true;
  } catch {
    return false;
  }
};

const login = async (page: Page): Promise<void> => {
  if (!(await hasLoginForm(page, 15_000))) {
    log('Session is still valid, no login needed');
    return;
  }

  log(`Signing in as ${mask(USERNAME)}`);
  const userValue = await setNovumValue(page, SEL.loginUserHost, USERNAME);
  const passValue = await setNovumValue(page, SEL.loginPassHost, PASSWORD);
  if (!userValue || !passValue) throw new Error('The login form did not accept the credentials');

  // Enter submits reliably; the novum button host often ignores synthetic clicks.
  await page.$eval(`${SEL.loginPassHost} >>> input`, element =>
    (element as HTMLInputElement).focus()
  );
  await page.keyboard.press('Enter');

  try {
    await page.waitForFunction(
      () => window.location.hostname.endsWith('alditalk-kundenportal.de'),
      { timeout: CFG.navTimeout }
    );
  } catch {
    throw new Error(
      'Login never reached the customer portal - wrong credentials, or a one-time password is required'
    );
  }
  log('Signed in');
};

interface InlandState {
  remainingText: string;
  remainingMb: number;
  actionText: string;
  actionDisabled: boolean;
}

const parseMegabytes = (text: string): number => {
  const match = text.replace(/\s/g, '').match(/([\d.,]+)(GB|MB|KB)/i);
  if (!match) return NaN;
  const [, rawAmount, rawUnit] = match;
  if (!rawAmount || !rawUnit) return NaN;
  const amount = Number(rawAmount.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(amount)) return NaN;
  switch (rawUnit.toUpperCase()) {
    case 'GB':
      return amount * 1024;
    case 'KB':
      return amount / 1024;
    default:
      return amount;
  }
};

const readInlandState = (page: Page): Promise<InlandState | null> =>
  page
    .evaluate((meterSel: string, buttonSel: string) => {
      const text = (value: string | null | undefined): string =>
        (value ?? '').replace(/\s+/g, ' ').trim();
      const meters = Array.from(document.querySelectorAll(meterSel));
      const inland =
        meters.find(meter => text(meter.querySelector('[slot="footer"]')?.textContent).includes('Inland')) ??
        meters[0];
      if (!inland) return null;

      const button = inland.querySelector(buttonSel);
      const nativeButton = button?.shadowRoot?.querySelector('button');
      return {
        remainingText: text(inland.querySelector('one-heading')?.textContent),
        actionText: text(button?.textContent),
        actionDisabled:
          !button || button.hasAttribute('disabled') || !!nativeButton?.hasAttribute('disabled'),
      };
    }, SEL.meter, SEL.actionButton)
    .then(state =>
      state === null ? null : { ...state, remainingMb: parseMegabytes(state.remainingText) }
    );

/**
 * Tag the Inland top-up button so it can be clicked by a precise selector.
 * Returns false when the meter has no action button.
 */
const markInlandButton = (page: Page): Promise<boolean> =>
  page.evaluate((meterSel: string, buttonSel: string) => {
    document.querySelectorAll('[data-topup-target]').forEach(el => el.removeAttribute('data-topup-target'));
    const text = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const meters = Array.from(document.querySelectorAll(meterSel));
    const inland =
      meters.find(meter => text(meter.querySelector('[slot="footer"]')?.textContent).includes('Inland')) ??
      meters[0];
    const button = inland?.querySelector(buttonSel);
    if (!button) return false;
    button.setAttribute('data-topup-target', 'inland');
    return true;
  }, SEL.meter, SEL.actionButton);

/** Is the button actually reachable, or is an overlay on top of it? */
const isButtonCovered = (page: Page): Promise<boolean> =>
  page.evaluate((buttonSel: string) => {
    const text = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const meters = Array.from(document.querySelectorAll('one-usage-meter'));
    const inland =
      meters.find(meter => text(meter.querySelector('[slot="footer"]')?.textContent).includes('Inland')) ??
      meters[0];
    const button = inland?.querySelector(buttonSel);
    if (!button) return true;

    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;

    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!top) return true;
    return !(top === button || button.contains(top) || top.contains(button));
  }, SEL.actionButton);

/** Wait (briefly) until nothing is covering the button, dismissing consent if needed. */
const ensureButtonReachable = async (page: Page, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await isButtonCovered(page))) return true;
    await dismissConsent(page);
    await sleep(1_000);
  } while (Date.now() < deadline);
  return !(await isButtonCovered(page));
};

const waitForVolumeAbove = async (
  page: Page,
  previousMb: number,
  timeoutMs: number
): Promise<number | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readInlandState(page);
    if (state && Number.isFinite(state.remainingMb) && state.remainingMb > previousMb + 1) {
      return state.remainingMb;
    }
    await sleep(2_000);
  }
  return null;
};

const bookOneGigabyte = async (page: Page): Promise<boolean> => {
  const before = await readInlandState(page);
  if (!before) {
    log('Could not find the Inland data meter');
    return false;
  }
  if (!Number.isFinite(before.remainingMb)) {
    log(`Could not parse the remaining volume from "${before.remainingText}"`);
    return false;
  }

  log(`Inland remaining: ${before.remainingText} (button: "${before.actionText}")`);

  if (before.remainingMb > CFG.thresholdMb) {
    log(`Still above ${(CFG.thresholdMb / 1024).toFixed(2)} GB - nothing to book`);
    return false;
  }
  if (before.actionDisabled) {
    log('The top-up button is currently disabled');
    return false;
  }
  if (CFG.dryRun) {
    log('Dry run - would have booked another GB now');
    return false;
  }

  // The consent dialog can reappear late; make sure the button is really reachable.
  if (!(await ensureButtonReachable(page))) {
    log('The top-up button stays covered by an overlay - skipping this cycle');
    return false;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!(await markInlandButton(page))) {
      log('The top-up button disappeared from the meter');
      return false;
    }

    const bookingResponse = page
      .waitForResponse(
        response =>
          /selfcare-dashboard\/v1\/offer\/update/.test(response.url()) &&
          response.request().method() === 'POST',
        { timeout: 20_000 }
      )
      .catch(() => null);

    await page.click('[data-topup-target="inland"]');
    log(`Pressed "1 GB"${attempt > 1 ? ' (retry)' : ''}, waiting for confirmation`);

    const response = await bookingResponse;
    if (!response) {
      // No request at all means nothing was booked, so retrying is safe.
      log('The click produced no request - the overlay probably swallowed it');
      if (attempt === 2) return false;
      await ensureButtonReachable(page);
      continue;
    }
    if (!response.ok()) {
      log(`The booking request failed with HTTP ${response.status()}`);
      return false;
    }

    const updatedMb = await waitForVolumeAbove(page, before.remainingMb, 45_000);
    if (updatedMb === null) {
      log('Booking accepted; the counter has not refreshed yet (the portal shows it "in Kürze")');
      return true;
    }
    log(`Booked: ${before.remainingText} -> ${(updatedMb / 1024).toFixed(2)} GB`);
    return true;
  }

  return false;
};

// ---------------------------------------------------------------------------
// Cycle + main loop
// ---------------------------------------------------------------------------
const runCycle = async (page: Page): Promise<void> => {
  const onPortal = await page.evaluate(() =>
    window.location.hostname.endsWith('alditalk-kundenportal.de')
  );

  if (!onPortal) {
    await page.goto(CFG.portalUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
  }

  await dismissConsent(page);
  await login(page);
  await dismissConsent(page);

  if (!(await hasSelector(page, SEL.meter, CFG.renderTimeout))) {
    throw new Error('The usage meter never appeared - the portal layout may have changed');
  }

  await bookOneGigabyte(page);
};

const launchBrowser = (): Promise<Browser> =>
  puppeteer.launch({
    headless: CFG.headless,
    executablePath: CFG.chromePath,
    userDataDir: CFG.profileDir, // persists the session so logins stay rare
    defaultViewport: { width: 1400, height: 1000 },
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      '--lang=de-DE',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
  });

const firstPage = async (browser: Browser): Promise<Page> =>
  (await browser.pages())[0] ?? (await browser.newPage());

const main = async (): Promise<void> => {
  log(
    `Starting (headless=${CFG.headless}, interval=${CFG.intervalMs / 60_000} min, ` +
      `threshold=${(CFG.thresholdMb / 1024).toFixed(2)} GB${CFG.dryRun ? ', dry run' : ''})`
  );

  let browser = await launchBrowser();
  let page = await firstPage(browser);

  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    log('Received shutdown signal');
    browser.close().catch(() => undefined).finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let failures = 0;

  while (!stopping) {
    try {
      await runCycle(page);
      failures = 0;
    } catch (error) {
      failures++;
      log(`Cycle failed (${failures} in a row): ${error instanceof Error ? error.message : String(error)}`);

      if (failures >= 2) {
        // A wedged browser cannot recover itself; start a clean one.
        try {
          await browser.close();
        } catch {
          /* already dead */
        }
        browser = await launchBrowser();
        page = await firstPage(browser);
        failures = 0;
      }
    }

    if (CFG.once) break;

    log(`Waiting ${CFG.intervalMs / 60_000} min before the next check`);
    await interruptibleSleep(CFG.intervalMs);
  }

  await browser.close().catch(() => undefined);
};

main().catch(error => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
