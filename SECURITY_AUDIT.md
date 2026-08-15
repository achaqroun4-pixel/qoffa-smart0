# Qoffa Smart — تقرير التدقيق الأمني

## النتيجة المختصرة

تم فحص نسخة الموقع المرفقة وتطبيق إصلاحات مباشرة على مشروع HTML/CSS/JavaScript. أخطر مشكلة كانت وجود **Baserow token بصلاحيات قراءة وكتابة داخل ملفات الواجهة**؛ وهذا يعني أن أي زائر كان يستطيع رؤية القيمة من أدوات المتصفح واستعمالها خارج الموقع. تم حذف القيمة من ملفات HTML وJavaScript، وإضافة gateway في `backend/cloudflare-worker.js` حتى يبقى السر في بيئة الخادم فقط.

> **مهم:** GitHub Pages ينشر HTML وCSS وJavaScript كملفات static، ولا يشغل PHP أو Python أو Node.js على الخادم [1]. لذلك لا يمكن وضع Baserow token داخل GitHub Pages بطريقة سرية. يجب نشر الـ Worker في خدمة serverless منفصلة، ثم وضع التوكن في Secrets الخاصة بها.

## ما تم اكتشافه

| الخطورة | المشكلة | الأثر المحتمل | الحالة |
|---|---|---|---|
| حرجة | Baserow token hardcoded في عدة ملفات HTML/JS | قراءة وتعديل المنتجات والطلبات والرسائل من خارج الموقع | عولجت في النسخة الحالية؛ يجب تدوير التوكن القديم عندما يصبح ذلك ممكناً |
| عالية | المتصفح كان يرسل مباشرة إلى Baserow بعمليات GET وPOST وPATCH | انتحال الطلبات، spam، وتغيير مخزون الأوزان | عولجت بتمرير الطلبات إلى backend gateway |
| عالية | service worker كان يحاول cache طلبات API | احتمال بقاء بيانات API في cache وتحميل بيانات قديمة | عولجت بمنع cache لطلبات API والطلبات غير GET |
| متوسطة | غياب CSP واضحة | سطح هجوم أكبر عند حدوث XSS أو تحميل مورد غير متوقع | أضيفت CSP إلى الصفحات |
| متوسطة | روابط `target="_blank"` من دون `noopener` في بعض المواضع | خطر tabnabbing في المتصفحات التي تتأثر بهذا السلوك | أضيف `rel="noopener noreferrer"` |
| متوسطة | inline scripts و`innerHTML` ما زالا موجودين في المشروع | يتطلبان مراجعة إضافية ضد DOM XSS إذا أصبحت البيانات غير موثوقة | لم تُلغَ بالكامل للحفاظ على التصميم الحالي؛ CSP الحالية تستعمل `unsafe-inline` كحل توافق مؤقت |
| منخفضة/مشروطة | Mapbox public token موجود في الواجهة | ليس secret بالمعنى نفسه، لكنه قد يستعمل خارج النطاق إذا لم تُضبط القيود | يجب تقييده من لوحة Mapbox حسب domain والـ scopes |

## الإصلاحات المضافة

أضيف الملف `assets/js/api-client.js`، وهو يعترض أي طلب مباشر إلى `api.baserow.io` ويحوّله إلى endpoint backend مثل `/api/products` أو `/api/orders`. لا يمرر هذا الملف أي Authorization header إلى المتصفح. أضيف كذلك `assets/js/runtime-config.js`، وفيه فقط رابط الـ backend العمومي؛ لا يجب وضع أي سر فيه.

أضيف `backend/cloudflare-worker.js` كـ gateway serverless. يحتوي على allowlist للجداول والعمليات، ويتحقق من Origin، ويضع rate limit بسيطاً، ويحد حجم المدخلات، ويتحقق من بعض الحقول قبل إرسالها إلى Baserow. كما يمنع إرجاع بيانات العملاء من endpoint المنتجات. التوكن نفسه لا يوجد في هذا الملف؛ يجب وضعه في Cloudflare Secret باسم `BASEROW_TOKEN`.

تم تحديث `service-worker.js` إلى cache version جديدة. الطلبات إلى Baserow المباشر أصبحت ترجع رفضاً، وطلبات `/api/` والطلبات غير GET لا تدخل إلى Cache API. هذا يمنع تخزين الطلبات أو ردود العمليات الحساسة في cache المتصفح.

تمت إضافة CSP إلى صفحات HTML، وتمت إضافة `.gitignore` لمنع `.env` و`.dev.vars` و`.wrangler` وملفات logs من الدخول إلى Git. كما تمت إضافة `backend/README.md` الذي يشرح إعداد Cloudflare Worker والـ secrets.

## طريقة النشر الصحيحة

أولاً، انشر محتوى مجلد `qoffa-smart-final-complete` إلى مستودع GitHub الذي سيخدم GitHub Pages. لا تضع Baserow token في أي commit، ولا في `runtime-config.js`.

ثانياً، أنشئ Cloudflare Worker جديداً وارفع `backend/cloudflare-worker.js`. أضف secret باسم `BASEROW_TOKEN`، ثم أضف variable باسم `ALLOWED_ORIGIN` يساوي رابط GitHub Pages الكامل، مثلاً `https://username.github.io/repository`. لا تستعمل `Access-Control-Allow-Origin: *` في الإنتاج.

ثالثاً، عدّل `assets/js/runtime-config.js` وضع رابط Worker العمومي فقط:

```js
window.QOFFA_API_BASE = 'https://qoffa-api.example.workers.dev';
```

رابعاً، فعّل **Enforce HTTPS** في إعدادات GitHub Pages. GitHub يوضح أن مواقع Pages تدعم HTTPS ويمكن فرض التحويل إليه [2].

خامساً، اختبر أن الموقع يطلب `/api/products` من Worker، وأنه لا توجد أي request من المتصفح إلى `api.baserow.io`. يمكن التأكد من ذلك من Developer Tools ثم Network.

## بخصوص التوكن القديم

رغم أن القيمة أزيلت من النسخة الجديدة، يجب اعتبار التوكن القديم مكشوفاً لأنه كان موجوداً في الواجهة وفي النسخة الأصلية. توصي إرشادات إدارة الأسرار بتطبيق أقل الصلاحيات، تدوير الأسرار، ومراقبة استعمالها [4]. عندما يصبح ممكناً، قم بإلغائه أو تدويره من Baserow، ثم أنشئ توكن جديداً بصلاحيات ضيقة على الجداول الضرورية فقط.

Baserow يدعم tokens بصلاحيات granular على مستوى database وtable، ويطلب وضعها في Authorization header مع تخزينها بشكل آمن [3]. في التصميم الجديد، هذا الـ header لا يظهر إلا داخل Worker.

## الاختبارات المنفذة

تم تشغيل `node --check` على ملفات JavaScript وWorker، وتم فحص جميع صفحات HTML. النتيجة:

```text
PASS
Checked 9 HTML pages, JavaScript syntax, and secret markers.
```

كما تم البحث عن القيمة القديمة داخل HTML وJavaScript ولم يتم العثور عليها في النسخة المعدلة.

## حدود الإصلاح الحالية

هذه النسخة أصبحت **جاهزة أمنياً من جهة فصل السر عن الواجهة**، لكن لا يمكن تشغيل Baserow من GitHub Pages وحده. إذا لم تنشر Worker ولم تضع رابطها في `runtime-config.js`، فطلبات المنتجات والطلبات والنماذج ستفشل بشكل آمن بدلاً من الاتصال المباشر بـ Baserow.

ما زالت بعض أجزاء المشروع تستعمل inline JavaScript و`innerHTML` لأن المشروع الأصلي مبني بهذه الطريقة. المرحلة التالية لتحسين الأمان أكثر هي نقل scripts المضمّنة إلى ملفات منفصلة، استعمال `textContent` وDOM APIs للبيانات، وإزالة `unsafe-inline` من CSP تدريجياً. كما يجب إضافة Cloudflare Turnstile أو حماية anti-spam مناسبة قبل فتح endpoints الخاصة بالطلبات والنماذج على نطاق واسع.

### المراجع

[1]: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages — GitHub Docs: What is GitHub Pages?  
[2]: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https — GitHub Docs: Securing your GitHub Pages site with HTTPS  
[3]: https://baserow.io/user-docs/database-api — Baserow: Database API documentation  
[4]: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html — OWASP: Secrets Management Cheat Sheet
