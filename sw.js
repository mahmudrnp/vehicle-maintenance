// ==========================================
// 9 EB MT Tracker Pro — Service Worker (ধাপ ৫.২)
// ==========================================
// কৌশল:
//   ১) App shell (HTML/navigation) → NETWORK-FIRST — নেট থাকলে সবসময় সর্বশেষ ভার্সন,
//      নেট না থাকলে cache থেকে fallback। এটাই সবচেয়ে গুরুত্বপূর্ণ — এর ফলে ইউজার কখনো
//      পুরনো/বাগযুক্ত ভার্সনে "আটকে" থাকবে না যতক্ষণ নেট সংযোগ আছে।
//   ২) স্ট্যাটিক CDN অ্যাসেট (Tailwind, Chart.js, Font Awesome, xlsx.js, ফন্ট) → CACHE-FIRST —
//      এগুলো কম বদলায়, তাই দ্রুত লোডের জন্য আগে cache চেক করা হয়।
//   ৩) Firestore / Firebase Auth / Google Apps Script sync কল → সম্পূর্ণ বাইপাস — এই SW কখনো
//      এসবে হস্তক্ষেপ করে না; Firestore SDK নিজেই IndexedDB দিয়ে অফলাইন সিঙ্ক সামলায়।
//
// ⚠️ ক্যাশ ভার্সনিং — গুরুত্বপূর্ণ ডিপ্লয়মেন্ট নিয়ম:
//   প্রতিবার HTML/CSS/JS-এ কোনো পরিবর্তন ডিপ্লয় করার আগে নিচের CACHE_VERSION সংখ্যাটি
//   অবশ্যই বাড়াতে হবে (v1 → v2 → v3 ...)। নাহলে activate ধাপে পুরনো cache মুছবে না এবং
//   কিছু ইউজার স্টেল (stale) অ্যাসেট দেখতে পারেন। এটা regenerate_csp_hash.py চালানোর
//   মতোই একটা মাস্ট-ডু ডিপ্লয়মেন্ট চেকলিস্ট আইটেম হিসেবে গণ্য করুন।
const CACHE_VERSION = 'v1';
const CACHE_NAME = `9eb-mt-tracker-${CACHE_VERSION}`;

// অ্যাপ-শেল — install-এর সময় প্রি-ক্যাশ করা হবে যাতে প্রথমবার অফলাইন হলেও বেসিক শেল লোড হয়।
// দ্রষ্টব্য: './' রিকোয়েস্ট সাধারণত সার্ভারের ডিফল্ট ডকুমেন্ট (index.html) সার্ভ করে।
// যদি আপনার লাইভ ফাইলের নাম index.html না হয়ে অন্য কিছু হয় (যেমন
// 9_eb_mt_tracker_pro.html), তাহলে সেই ফাইলনামটি এই তালিকায় যোগ করুন।
const APP_SHELL = [
    './',
    'manifest.json',
    'logo.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-512-maskable.png'
];

// এই হোস্টগুলোর কোনো রিকোয়েস্ট এই SW কখনো ইন্টারসেপ্ট করবে না —
// সরাসরি নেটওয়ার্কে যাবে (Firestore রিয়েল-টাইম সিঙ্ক ও Auth-এর জন্য জরুরি)।
const BYPASS_HOSTS = [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'www.googleapis.com',
    'script.google.com',
    'script.googleusercontent.com'
];

// ---------- INSTALL ----------
self.addEventListener('install', (event) => {
    event.skipWaiting(); // নতুন SW সাথে সাথে সক্রিয় হবে (পরবর্তী fetch থেকেই কার্যকর)
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // কোনো একটা অ্যাসেট fetch ব্যর্থ হলেও যেন পুরো install ব্যর্থ না হয়,
            // তাই প্রতিটা আলাদাভাবে try/catch করা হয়েছে।
            return Promise.all(
                APP_SHELL.map((url) =>
                    cache.add(url).catch((err) => {
                        console.warn('[SW] প্রি-ক্যাশ ব্যর্থ:', url, err);
                    })
                )
            );
        })
    );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME) // পুরনো ভার্সনের cache মুছে ফেলা (cache invalidation)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // POST (যেমন Google Sheets sync) বা GET ছাড়া অন্য মেথড — কখনো ইন্টারসেপ্ট না করা
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (e) { return; }

    // Firestore / Auth / Apps Script — সম্পূর্ণ বাইপাস
    if (BYPASS_HOSTS.some((h) => url.hostname.includes(h))) return;

    // নেভিগেশন রিকোয়েস্ট (HTML পেজ লোড) → Network-First
    const isNavigation = req.mode === 'navigate' ||
        (url.origin === self.location.origin && url.pathname.endsWith('.html'));

    if (isNavigation) {
        event.respondWith(networkFirst(req));
        return;
    }

    // বাকি সব (স্ট্যাটিক CDN CSS/JS/ফন্ট, ম্যানিফেস্ট, আইকন) → Cache-First
    event.respondWith(cacheFirst(req));
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const freshResponse = await fetch(request);
        if (freshResponse && freshResponse.status === 200) {
            cache.put(request, freshResponse.clone());
        }
        return freshResponse;
    } catch (err) {
        const cachedResponse = await cache.match(request, { ignoreSearch: true });
        if (cachedResponse) return cachedResponse;
        // কোনো cache-ও নেই, নেটও নেই — ব্রাউজারের ডিফল্ট অফলাইন এরর দেখানো হবে।
        throw err;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    try {
        const freshResponse = await fetch(request);
        // opaque (no-cors cross-origin) রেসপন্সও ক্যাশ করা নিরাপদ।
        if (freshResponse && (freshResponse.status === 200 || freshResponse.type === 'opaque')) {
            cache.put(request, freshResponse.clone());
        }
        return freshResponse;
    } catch (err) {
        throw err;
    }
}
