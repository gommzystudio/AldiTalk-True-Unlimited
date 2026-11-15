/*
 * Runs inside the portal WebView. Injected after every page load.
 *
 * Kept deliberately defensive: the portal is a novum web-component app with
 * open shadow roots, so every lookup walks the composed tree. All results are
 * reported back to Kotlin through AndroidBridge.report().
 *
 * Config is injected by the host as window.__ALDI_CFG:
 *   { user, pass, thresholdMb }
 */
(function () {
    if (window.__ALDI) {
        return;
    }

    var cfg = window.__ALDI_CFG || {};
    var threshold = typeof cfg.thresholdMb === 'number' ? cfg.thresholdMb : 1024;
    var RESET_FLAG = '__aldi_reset';
    var FIRST_FLAG = '__aldi_first';
    var PENDING_KEY = '__aldi_pending_click';
    /** How long a pressed button is trusted before another click is allowed. */
    var PENDING_TTL_MS = 25 * 60 * 1000;

    var S = {
        done: false,
        filled: false,
        attempts: 0,
        clickedAt: 0,
        beforeMb: 0,
        beforeText: '',
        phase: 'start'
    };
    window.__ALDI = S;

    function norm(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function report(phase, extra) {
        // Only report transitions: the tick loop would otherwise flood logcat.
        if (phase === S.phase) {
            return;
        }
        S.phase = phase;
        var payload = {phase: phase};
        if (extra) {
            for (var key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) {
                    payload[key] = extra[key];
                }
            }
        }
        try {
            AndroidBridge.report(JSON.stringify(payload));
        } catch (ignored) {
            /* not hosted by the app */
        }
    }

    /** Collect every element in the light DOM and open shadow roots. */
    function allElements(root, out) {
        var nodes = root.querySelectorAll('*');
        for (var i = 0; i < nodes.length; i++) {
            out.push(nodes[i]);
            if (nodes[i].shadowRoot) {
                allElements(nodes[i].shadowRoot, out);
            }
        }
        return out;
    }

    function deepQuery(selector) {
        var nodes = allElements(document, []);
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].matches && nodes[i].matches(selector)) {
                return nodes[i];
            }
        }
        return null;
    }

    function consentVisible() {
        return !!deepQuery('[data-testid="uc-accept-all-button"]');
    }

    /** The real <input> inside a novum <one-input>. */
    function novumInput(id) {
        var host = document.querySelector(id);
        return host && host.shadowRoot ? host.shadowRoot.querySelector('input') : null;
    }

    /**
     * Tells us whether the portal submits the login form itself (a real submit
     * event) or whether the document is swapped out without one. Registered
     * once per document, in the capture phase so nothing can stop it first.
     */
    function watchForm() {
        if (window.__ALDI_WATCH) {
            return;
        }
        window.__ALDI_WATCH = true;
        document.addEventListener('submit', function (event) {
            var form = event.target;
            report('submit-event', {
                url: location.href,
                id: form && form.id ? form.id : '',
                trusted: !!event.isTrusted
            });
        }, true);
        window.addEventListener('pagehide', function () {
            report('page-hide', {url: location.href});
        }, true);
    }

    function setValue(input, value) {
        var descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        descriptor.set.call(input, value);
        ['input', 'change', 'blur'].forEach(function (type) {
            input.dispatchEvent(new Event(type, {bubbles: true, composed: true}));
        });
    }

    /**
     * There is no keyboard here, so escalate: inner <a> of the novum button,
     * then the legacy form's requestSubmit(), then a synthetic Enter.
     */
    function submitLogin(passwordInput) {
        if (S.attempts === 1 || S.attempts === 2) {
            var host = document.querySelector('#IDToken5_4_od_2');
            var link = host && host.shadowRoot ? host.shadowRoot.querySelector('a') : null;
            if (link) {
                link.click();
                return 'button';
            }
        }
        if (S.attempts === 3) {
            var form = document.querySelector('form#js-authform');
            if (form && form.requestSubmit) {
                form.requestSubmit();
                return 'requestSubmit';
            }
        }
        passwordInput.focus();
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
            passwordInput.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, composed: true
            }));
        });
        return 'enter';
    }

    function parseMegabytes(text) {
        var match = text.replace(/\s/g, '').match(/([\d.,]+)(GB|MB|KB)/i);
        if (!match) {
            return NaN;
        }
        var amount = Number(match[1].replace(/\./g, '').replace(',', '.'));
        if (!isFinite(amount)) {
            return NaN;
        }
        var unit = match[2].toUpperCase();
        if (unit === 'GB') {
            return amount * 1024;
        }
        if (unit === 'KB') {
            return amount / 1024;
        }
        return amount;
    }

    /** The Inland meter is identified by its "Inland" footer. */
    function findMeter() {
        var meters = document.querySelectorAll('one-usage-meter');
        var inland = null;
        for (var i = 0; i < meters.length; i++) {
            var footer = meters[i].querySelector('[slot="footer"]');
            if (norm(footer && footer.textContent).indexOf('Inland') !== -1) {
                inland = meters[i];
                break;
            }
        }
        if (!inland && meters.length) {
            inland = meters[0];
        }
        if (!inland) {
            return null;
        }
        var heading = inland.querySelector('one-heading');
        var remaining = norm(heading && heading.textContent);
        return {
            remaining: remaining,
            mb: parseMegabytes(remaining),
            button: inland.querySelector('one-button[slot="action"]')
        };
    }

    /** The last press that has not been confirmed by a rising counter yet. */
    function readPending() {
        try {
            var raw = localStorage.getItem(PENDING_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (ignored) {
            return null;
        }
    }

    function writePending(meter) {
        try {
            localStorage.setItem(PENDING_KEY, JSON.stringify({
                before: meter.remaining,
                mb: meter.mb,
                at: Date.now()
            }));
        } catch (ignored) {
            /* storage unavailable - the click still happens */
        }
    }

    function clearPending() {
        try {
            localStorage.removeItem(PENDING_KEY);
        } catch (ignored) {
            /* nothing to clear */
        }
    }

    function bookingConfirmed() {        var nodes = allElements(document, []);
        for (var i = 0; i < nodes.length; i++) {
            if (norm(nodes[i].textContent).indexOf('Nachbuchung ist eingegangen') !== -1) {
                return true;
            }
        }
        return false;
    }

    function tick() {
        if (S.done) {
            return;
        }

        // The portal bounces to /erneut-versuchen/ when a micro-frontend fails
        // to boot - usually because the session cookie is dead. Nothing to do
        // here: the anonymous-shell handling below wipes the cookies.
        if (location.pathname.indexOf('erneut-versuchen') !== -1) {
            report('retry-page', {text: norm(document.body && document.body.innerText).slice(0, 120)});
        }

        // 1. Cookie consent covers the meter and must go first.
        if (consentVisible()) {
            var accept = deepQuery('[data-testid="uc-accept-all-button"]');
            if (accept) {
                accept.click();
                report('consent-dismissed');
                return;
            }
        }

        // 2. Login form.
        var user = novumInput('#idToken3_od');
        var pass = novumInput('#idToken4_od');
        if (user || pass) {
            watchForm();
            sessionStorage.removeItem(RESET_FLAG);
            sessionStorage.removeItem(FIRST_FLAG);
            if (!S.filled) {
                if (user) {
                    setValue(user, cfg.user);
                }
                if (pass) {
                    setValue(pass, cfg.pass);
                }
                S.filled = true;
                report('login-filled', {
                    url: location.href,
                    hasUser: !!user,
                    hasPass: !!pass,
                    userLen: user ? user.value.length : -1,
                    passLen: pass ? pass.value.length : -1,
                    wantUserLen: (cfg.user || '').length,
                    wantPassLen: (cfg.pass || '').length
                });
                return;
            }
            if (!user || !pass) {
                report('login-partial', {
                    url: location.href,
                    hasUser: !!user,
                    hasPass: !!pass
                });
                return;
            }
            S.attempts += 1;
            if (S.attempts > 6) {
                S.done = true;
                report('login-failed', {attempts: S.attempts, url: location.href});
                return;
            }
            report('login-submit', {
                how: submitLogin(pass),
                attempts: S.attempts,
                url: location.href,
                userLen: user.value.length,
                passLen: pass.value.length
            });
            return;
        }

        // 3. Logged in - read the meter.
        var meter = findMeter();
        if (!meter) {
            // A dead session cookie makes the portal serve the anonymous shell
            // without ever showing the login form, and every BFF call 404s.
            // The deadline lives in sessionStorage so page reloads cannot reset it.
            var first = Number(sessionStorage.getItem(FIRST_FLAG) || '0');
            if (!first) {
                first = Date.now();
                sessionStorage.setItem(FIRST_FLAG, String(first));
            }
            var age = Date.now() - first;
            if (!sessionStorage.getItem(RESET_FLAG) && age > 12000) {
                sessionStorage.setItem(RESET_FLAG, '1');
                report('session-reset', {url: location.href, age: age});
                try {
                    AndroidBridge.resetSession();
                } catch (ignored) {
                    /* not hosted by the app */
                }
                return;
            }
            if (sessionStorage.getItem(RESET_FLAG) && age > 90000) {
                S.done = true;
                report('no-portal', {url: location.href, age: age});
                return;
            }
            report('waiting-meter', {
                url: location.href,
                meters: document.querySelectorAll('one-usage-meter').length,
                sample: norm(document.body && document.body.textContent).slice(0, 160)
            });
            return;
        }
        sessionStorage.removeItem(RESET_FLAG);
        sessionStorage.removeItem(FIRST_FLAG);

        // A booking reloads the page, so the click has to be remembered across
        // documents. localStorage also stops a second click while the portal is
        // still lagging behind the real counter.
        var pending = readPending();
        if (pending) {
            if (bookingConfirmed() || meter.mb > pending.mb + 1) {
                clearPending();
                S.done = true;
                report('booked', {before: pending.before, after: meter.remaining});
                return;
            }
            if (Date.now() - pending.at < PENDING_TTL_MS) {
                S.done = true;
                report('waiting-confirmation', {
                    before: pending.before,
                    after: meter.remaining,
                    already: true
                });
                return;
            }
            clearPending();
        }

        if (S.clickedAt) {
            if (bookingConfirmed() || meter.mb > S.beforeMb + 1) {
                S.done = true;
                report('booked', {before: S.beforeText, after: meter.remaining});
                return;
            }
            if (Date.now() - S.clickedAt > 45000) {
                S.done = true;
                report('clicked-unconfirmed', {before: S.beforeText, after: meter.remaining});
                return;
            }
            report('waiting-confirmation', {after: meter.remaining});
            return;
        }

        if (!(meter.mb <= threshold)) {
            S.done = true;
            report('idle', {remaining: meter.remaining, mb: meter.mb});
            return;
        }
        if (!meter.button) {
            S.done = true;
            report('no-button', {remaining: meter.remaining});
            return;
        }

        S.beforeMb = meter.mb;
        S.beforeText = meter.remaining;
        S.clickedAt = Date.now();
        // Recorded before the click: the portal may tear the page down the
        // moment the request is accepted.
        writePending(meter);
        meter.button.click();
        report('clicked', {remaining: meter.remaining});
    }

    var timer = setInterval(function () {
        try {
            tick();
        } catch (error) {
            report('error', {message: String((error && error.message) || error)});
        }
        if (S.done) {
            clearInterval(timer);
        }
    }, 1500);

    setTimeout(function () {
        if (!S.done) {
            S.done = true;
            report('timeout', {stoppedAt: S.phase});
        }
    }, 180000);

    report('loaded', {url: location.href});

    try {
        tick();
    } catch (error) {
        report('error', {message: String((error && error.message) || error)});
    }
})();