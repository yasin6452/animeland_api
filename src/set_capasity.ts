import fetch from 'node-fetch';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

// ==== تنظیمات ArvanCloud S3 ====
const s3Client = new S3Client({
    region: 'ir-thr-at1',
    endpoint: '',
    credentials: {
        accessKeyId: '',
        secretAccessKey: ''
    },
    forcePathStyle: true
});

const BUCKET = 'animeland-links';

// ==== تنظیمات وردپرس ====
const WP_BASE = '';
const USERNAME = '';
const PASSWORD = '';
const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

const wpHeaders = {
    'Authorization': authHeader,
    'Content-Type': 'application/json'
};

// تبدیل بایت به فرمت M یا GB
const bytesToCapacity = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    if (mb < 950) {
        return `${Math.round(mb)}M`;
    } else {
        const gb = mb / 1024;
        return `${gb.toFixed(1)}GB`;
    }
};

// تبدیل ظرفیت فعلی به مگابایت برای مقایسه
const capacityToMb = (capacity: string): number => {
    if (!capacity || capacity === 'نامشخص') return 0;
    const num = parseFloat(capacity.replace(/[^0-9.]/g, ''));
    return capacity.includes('GB') ? num * 1024 : num;
};

// گرفتن حجم فایل از S3
const getFileSizeFromS3 = async (key: string): Promise<number | null> => {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key;
    try {
        const command = new HeadObjectCommand({ Bucket: BUCKET, Key: cleanKey });
        const response = await s3Client.send(command);
        return response.ContentLength ?? null;
    } catch (err: any) {
        // فقط در صورت نبود فایل لاگ بده، خطاهای دیگه رو سایلنت نگه دار
        if (err.name !== 'NotFound') {
            console.log(`   ⚠️ خطا در دسترسی به ${cleanKey}`);
        }
        return null;
    }
};

// آپدیت حجم یک انیمه
const updateAnimeVolumes = async (animeId: number, animeTitle: string) => {
    const res = await fetch(`${WP_BASE}/series/${animeId}`, { headers: wpHeaders });
    if (!res.ok) {
        if (res.status === 404) {
            console.log(`   ⚠️ انیمه ${animeId} وجود ندارد (حذف شده)`);
        } else {
            console.log(`   ❌ خطا در دریافت ${animeId}: ${res.status}`);
        }
        return false;
    }

    const details: any = await res.json();
    let dlbox: any[] = details.meta?.series_dlbox || [];

    if (!Array.isArray(dlbox) || dlbox.length === 0) {
        console.log(`   ℹ️ ${animeTitle} — بدون گروه دانلود`);
        return false;
    }

    let hasUpdate = false;

    for (const group of dlbox) {
        const quality = (group.quality || '').trim().toUpperCase();
        const oldCapacity = group.capacity || 'نامشخص';
        const items = group.items || [];

        if (items.length === 0 || !quality) continue;

        // نمونه‌گیری: حداکثر 8 فایل اول
        const sampleLinks = items.slice(0, 8)
            .map((item: any) => item.play_link || item.link)
            .filter(Boolean);

        const sizes: number[] = [];
        for (const link of sampleLinks) {
            const size = await getFileSizeFromS3(link);
            if (size) sizes.push(size);
        }

        if (sizes.length === 0) continue;

        const avgBytes = sizes.reduce((a, b) => a + b, 0) / sizes.length;
        const newCapacity = bytesToCapacity(avgBytes);

        const oldMb = capacityToMb(oldCapacity);
        const newMb = parseFloat(newCapacity.replace(/M|GB/, '')) * (newCapacity.includes('GB') ? 1024 : 1);

        if (Math.abs(newMb - oldMb) > 20) {
            group.capacity = newCapacity;
            hasUpdate = true;
            console.log(`   ✅ ${quality}: ${oldCapacity} → ${newCapacity}`);
        }
    }

    if (hasUpdate) {
        const body = { meta: { series_dlbox: dlbox } };
        const patchRes = await fetch(`${WP_BASE}/series/${animeId}`, {
            method: 'PATCH',
            headers: wpHeaders,
            body: JSON.stringify(body)
        });

        if (patchRes.ok) {
            console.log(`   🎉 آپدیت شد: ${animeTitle}\n`);
            return true;
        } else {
            console.log(`   ❌ خطا در آپدیت ${animeId}: ${await patchRes.text()}\n`);
            return false;
        }
    } else {
        console.log(`   ℹ️ بدون تغییر: ${animeTitle}\n`);
        return false;
    }
};

// ==== اجرای کامل روی همه صفحات ====
const updateAllAnimes = async () => {
    const perPage = 10;
    let page = 1;
    let updatedCount = 0;
    let processedCount = 0;

    console.log('🚀 شروع آپدیت حجم تمام انیمه‌ها (113 صفحه × 10)\n');

    while (true) {
        console.log(`📄 صفحه ${page}/113 — در حال دریافت لیست انیمه‌ها...`);

        const listRes = await fetch(`${WP_BASE}/series?per_page=${perPage}&page=${page}&orderby=title&order=asc`, {
            headers: wpHeaders
        });

        if (!listRes.ok) {
            console.error(`❌ خطا در دریافت صفحه ${page}: ${await listRes.text()}`);
            break;
        }

        const animes: any[] = await listRes.json();
        if (animes.length === 0) {
            console.log('✅ تمام صفحات پردازش شد.');
            break;
        }

        console.log(`   ${animes.length} انیمه پیدا شد.\n`);

        for (const anime of animes) {
            processedCount++;
            const title = anime.title.rendered.replace(/دانلود انیمه | با زیرنویس فارسی.*/g, '').trim();
            console.log(`[${processedCount}] پردازش: ${title} (ID: ${anime.id})`);

            const updated = await updateAnimeVolumes(anime.id, title);
            if (updated) updatedCount++;

            // صبر 2 ثانیه بین هر انیمه (ایمن و مودبانه)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        page++;

        // اگر به صفحه 113 رسیدی یا کمتر از 10 تا بود، تموم کن
        if (page > 113 || animes.length < perPage) {
            break;
        }
    }

    console.log('🎊 تمام شد!');
    console.log(`📊 آمار نهایی: ${processedCount} انیمه پردازش شد — ${updatedCount} انیمه آپدیت شد.`);
};

updateAllAnimes().catch(err => console.error('خطای کلی:', err));
