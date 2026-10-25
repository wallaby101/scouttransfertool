// Service worker registration and the update prompt.
//
// Loaded only by the built static site (tools/build_static.py injects the tag);
// the Flask version serves no sw.js and does not need one.
//
// The update prompt is the important part. A service worker that calls
// skipWaiting() on its own can swap the app out from under someone mid-job, and
// one that never activates leaves them on a stale build forever — which would
// quietly defeat the whole point of being able to push updates. So: the new
// worker waits, the page says a new version is ready, and it activates when the
// user clicks. Nothing changes while they are in the middle of something.

(function () {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    let refreshing = false;

    function showUpdatePrompt(worker) {
        if (document.getElementById('pwa-update')) return;

        const bar = document.createElement('div');
        bar.id = 'pwa-update';
        bar.setAttribute('role', 'status');
        bar.innerHTML = '<span>A new version is ready.</span>'
            + '<button type="button" id="pwa-update-btn">Reload</button>'
            + '<button type="button" id="pwa-update-dismiss" '
            + 'aria-label="Dismiss">&times;</button>';
        document.body.appendChild(bar);

        document.getElementById('pwa-update-btn').addEventListener('click', () => {
            // Tell the waiting worker to take over; the controllerchange
            // handler below reloads once it has.
            worker.postMessage({ type: 'SKIP_WAITING' });
        });
        document.getElementById('pwa-update-dismiss').addEventListener('click', () => {
            bar.remove();
        });
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then((reg) => {
            // A worker already waiting when the page loads.
            if (reg.waiting && navigator.serviceWorker.controller) {
                showUpdatePrompt(reg.waiting);
            }

            reg.addEventListener('updatefound', () => {
                const installing = reg.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    // "installed" with an existing controller means this is an
                    // update rather than the very first install.
                    if (installing.state === 'installed'
                        && navigator.serviceWorker.controller) {
                        showUpdatePrompt(installing);
                    }
                });
            });

            // Check for a new build when the app regains focus, so a long-lived
            // standalone window still picks updates up.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    reg.update().catch(() => {});
                }
            });
        }).catch((err) => {
            // Offline support is a bonus; the app works without it.
            console.warn('Service worker registration failed:', err);
        });
    });
}());
