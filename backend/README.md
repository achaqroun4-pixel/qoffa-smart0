# Qoffa secure backend

GitHub Pages يخدم الملفات static فقط، لذلك لا يمكنه حفظ Baserow token بشكل سري. هذا المجلد يحتوي على Cloudflare Worker صغير يعمل كـ API gateway بين الموقع وBaserow.

## الإعداد

1. أنشئ Worker جديداً في Cloudflare، ثم ارفع `cloudflare-worker.js`.
2. أضف secret باسم `BASEROW_TOKEN` باستعمال Cloudflare Secrets، وليس داخل GitHub أو داخل هذا الملف.
3. أضف المتغير `ALLOWED_ORIGIN` بقيمة رابط GitHub Pages الكامل، مثال: `https://username.github.io/repository`.
4. أضف اختيارياً `MAX_REQUESTS_PER_MINUTE=60`.
5. إذا كانت النماذج العمومية تتعرض للspam، أضف Cloudflare Turnstile secret باسم `TURNSTILE_SECRET`؛ عندها خاص الواجهة تبعث `X-Turnstile-Token` مع الطلبات.
6. بعد النشر، افتح `assets/js/api-client.js` وغيّر `window.QOFFA_API_BASE` أو أضف نفس القيمة قبل تحميله في صفحات HTML، مثال: `https://qoffa-api.example.workers.dev`.

## المتغيرات السرية

```text
BASEROW_TOKEN=توكن Baserow
```

لا تضف هذه القيمة إلى GitHub. إذا سبق نشر التوكن القديم، خاص يتبدل في Baserow عندما يصبح ذلك ممكناً، لأن إزالة القيمة من الكود لا تلغي نسخها القديمة.

## الوظائف المتاحة

```text
GET  /api/products
GET  /api/products/:id
PATCH /api/products/:id/weights
GET  /api/banners
POST /api/orders
POST /api/sold-products
POST /api/contact
POST /api/contact-legacy
```

الـ Worker يستعمل allowlist للجداول، يتحقق من Origin، يطبق rate limit بسيطاً، يتحقق من حجم ونوع البيانات، ولا يعيد Baserow response الكامل للعمليات الحساسة. بيانات المنتجات العمومية تنظف من الحقول التي تبدو حساسة قبل إرجاعها.

## اختبار سريع

من بعد ما تحط `ALLOWED_ORIGIN` وتربط الموقع بالـ Worker، جرّب:

```bash
curl -i -X OPTIONS \
  -H "Origin: https://username.github.io/repository" \
  https://qoffa-api.example.workers.dev/api/products
```

خاص الطلب من origin مختلف يرجع `403`. لا تستعمل `Access-Control-Allow-Origin: *` في الإنتاج.
