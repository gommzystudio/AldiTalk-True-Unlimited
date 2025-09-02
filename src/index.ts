import puppeteer, { Browser, Page } from 'puppeteer';
import { config } from 'dotenv';

config();

// Constants
const URLS = {
  ALDITALK_PORTAL: 'https://www.alditalk-kundenportal.de/portal/auth/uebersicht/'
} as const;

const SELECTORS = {
  DATA_BUTTON: 'one-button[slot="action"]',
  DATA_TEXT: 'one-text',
  COOKIE_ACCEPT: '::-p-aria([name="Akzeptieren"][role="button"])',
  USERNAME_FIELD: '::-p-aria([name="Rufnummer"])',
  PASSWORD_FIELD: '::-p-aria([name="Passwort"])',
  LOGIN_BUTTON: '::-p-aria([name="Anmelden"][role="button"])'
} as const;

const TIMEOUTS = {
  COOKIE_WAIT: 10,
  SHORT_WAIT: 5,
  EXTEND_WAIT: 10,
  LOOP_INTERVAL: 15 * 60 // 15 minutes
} as const;

// Utility functions
const wait = (seconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, seconds * 1000));

const createBrowser = async (): Promise<Browser> => {
  return await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });
};

// Page interaction functions
const waitForPageLoad = async (page: Page): Promise<void> => {
  while (true) {
    const isLoaded = await page.evaluate(() => document.readyState === 'complete');

    if (isLoaded) {
      console.log('Page loaded successfully');
      return;
    }

    console.log('Waiting for page to load...');
    await wait(TIMEOUTS.SHORT_WAIT);
  }
};

const acceptCookies = async (page: Page): Promise<void> => {
  await wait(TIMEOUTS.COOKIE_WAIT);

  try {
    await page.locator(SELECTORS.COOKIE_ACCEPT).click();
    console.log('Cookies accepted');
    await wait(TIMEOUTS.SHORT_WAIT);
  } catch (error) {
    console.log('Cookie banner not found or already accepted');
  }
};

const performLogin = async (page: Page): Promise<void> => {
  const { USERNAME, PASSWORD } = process.env;

  if (!USERNAME || !PASSWORD) {
    throw new Error('Username or password not found in environment variables');
  }

  console.log(`Logging in with username: ${USERNAME}`);

  await page.locator(SELECTORS.USERNAME_FIELD).fill(USERNAME);
  await wait(TIMEOUTS.SHORT_WAIT);

  await page.locator(SELECTORS.PASSWORD_FIELD).fill(PASSWORD);
  await wait(TIMEOUTS.SHORT_WAIT);

  await page.locator(SELECTORS.LOGIN_BUTTON).click();
  await wait(TIMEOUTS.SHORT_WAIT);

  console.log('Login submitted');
};

const findDataVolumeButton = async (page: Page) => {
  const buttons = await page.$$(SELECTORS.DATA_BUTTON);

  for (const button of buttons) {
    try {
      const textContent = await button.$eval(SELECTORS.DATA_TEXT, el => el.textContent?.trim());
      if (textContent === '1 GB') {
        return button;
      }
    } catch {
      // Button has no text element, skip
      continue;
    }
  }

  return null;
};

const extendDataVolume = async (page: Page): Promise<void> => {
  await wait(TIMEOUTS.EXTEND_WAIT);

  try {
    const button = await findDataVolumeButton(page);

    if (button) {
      await button.click();
      console.log('Data volume extended successfully (1 GB button clicked)');
    } else {
      console.log('1 GB button not found - page structure might have changed');
    }
  } catch (error) {
    console.error('Error extending data volume:', error);
  }

  await wait(TIMEOUTS.EXTEND_WAIT);
};

// Main execution functions
const executeAutomation = async (): Promise<void> => {
  const browser = await createBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1024 });
    await page.goto(URLS.ALDITALK_PORTAL);

    await waitForPageLoad(page);
    await acceptCookies(page);
    await performLogin(page);
    await waitForPageLoad(page);
    await acceptCookies(page); // Sometimes needed after login
    await extendDataVolume(page);

    console.log('Automation completed successfully');
  } finally {
    await browser.close();
  }
};

const startMainLoop = async (): Promise<void> => {
  while (true) {
    try {
      await executeAutomation();
    } catch (error) {
      console.error('Error in automation:', error);
    }

    console.log(`Waiting ${TIMEOUTS.LOOP_INTERVAL / 60} minutes before next check...`);
    await wait(TIMEOUTS.LOOP_INTERVAL);
  }
};

// Start the application
startMainLoop().catch(error => {
  console.error('Fatal error in main loop:', error);
});
