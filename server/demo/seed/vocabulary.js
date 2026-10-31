/**
 * Invented content for the demo organization: a multinational, Arabic-speaking
 * enterprise software company with a customer portal, an operations platform
 * and a shared cloud platform. Project names are English, team names Arabic,
 * and work item titles mix Arabic with the English technical terms engineering
 * teams use day to day. Every name and title here is made up.
 */

// key, display name, email handle, team, app role, job title (not rendered by the app)
const PEOPLE = [
  ['abdullah', 'عبدالله الشهري', 'abdullah.alshehri', null, 'lead', 'مدير مشروع'],
  ['mona', 'منى أحمد', 'mona.ahmed', 'apps', 'lead', 'قائد فريق تقني'],
  ['khaled', 'خالد الحربي', 'khaled.alharbi', 'ux', 'lead', 'قائد فريق تقني'],
  ['noura', 'نورة السبيعي', 'noura.alsubaie', 'ops', 'lead', 'قائد فريق تقني'],
  ['mahmoud', 'محمود السيد', 'mahmoud.elsayed', 'infra', 'lead', 'قائد فريق تقني'],
  ['sara', 'سارة الدوسري', 'sara.aldosari', 'apps', 'principal', 'مهندس برمجيات'],
  ['aya', 'آية محمد', 'aya.mohamed', 'apps', 'scrum', 'محلل أعمال'],
  ['mohammed', 'محمد العتيبي', 'mohammed.alotaibi', 'apps', 'developer', 'مهندس Backend'],
  ['yasmine', 'ياسمين علي', 'yasmine.ali', 'apps', 'developer', 'مهندس واجهات أمامية'],
  ['ahmed', 'أحمد عبدالسلام', 'ahmed.abdelsalam', 'apps', 'developer', 'مهندس DevOps'],
  ['fatima', 'فاطمة الزهراني', 'fatima.alzahrani', 'ux', 'developer', 'مصمم تجربة المستخدم'],
  ['mostafa', 'مصطفى إبراهيم', 'mostafa.ibrahim', 'ux', 'developer', 'مهندس ضمان الجودة'],
  ['ahmedq', 'أحمد القحطاني', 'ahmed.alqahtani', 'ops', 'developer', 'مهندس بيانات'],
  ['omar', 'عمر حسن', 'omar.hassan', 'ops', 'developer', 'مهندس برمجيات'],
  ['abdulrahman', 'عبدالرحمن الغامدي', 'abdulrahman.alghamdi', 'infra', 'developer', 'مهندس أمن سيبراني'],
  ['nada', 'ندى حسن', 'nada.hassan', 'infra', 'developer', 'مهندس Backend'],
];

const TEAMS = [
  { key: 'apps', name: 'فريق التطبيقات المؤسسية' },
  { key: 'ux', name: 'فريق تجربة المستخدم' },
  { key: 'ops', name: 'فريق العمليات التقنية' },
  { key: 'infra', name: 'فريق البنية التحتية' },
];

// Per project: epics, each with features, each with a bank of story titles.
const BACKLOG = {
  'Customer Experience Portal': [
    {
      epic: 'تحسين تجربة العميل (Customer Experience)',
      features: [
        {
          name: 'Customer Onboarding Journey',
          stories: [
            'تحسين Customer Onboarding Journey وتقليل خطوات التسجيل',
            'حفظ بيانات العميل تلقائياً أثناء التسجيل (Auto-save)',
            'التحقق الفوري من البيانات في Registration Form',
            'إرسال Welcome Email بعد تفعيل الحساب',
            'تسجيل الدخول بدون كلمة مرور باستخدام One-Time Code',
            'استعادة التسجيل غير المكتمل بعد انقطاع الاتصال',
          ],
        },
        {
          name: 'Self-Service Portal',
          stories: [
            'تطوير صفحة Dashboard جديدة مع تحسين تجربة المستخدم',
            'تمكين العميل من متابعة حالة الطلبات في Self-Service Portal',
            'إضافة Notification Center لعرض التنبيهات داخل البوابة',
            'تحسين Search في قاعدة المعرفة (Knowledge Base)',
            'دعم Dark Mode في Customer Portal',
          ],
        },
        {
          name: 'Billing and Payments',
          stories: [
            'إضافة طرق دفع جديدة في Payment Gateway',
            'عرض Invoice History مع إمكانية التصدير PDF',
            'إعادة محاولة الدفع تلقائياً عند فشل Transaction',
            'Refund Workflow للطلبات الملغاة',
          ],
        },
      ],
    },
    {
      epic: 'الأمان وإدارة الوصول (Access Management)',
      features: [
        {
          name: 'Role-Based Access Control',
          stories: [
            'إضافة إمكانية إدارة صلاحيات المستخدمين باستخدام Role-Based Access Control',
            'شاشة Audit Log لمتابعة تغييرات الصلاحيات',
            'دعم Multi-Factor Authentication للحسابات الإدارية',
            'ربط الصلاحيات بالـ Single Sign-On',
          ],
        },
        {
          name: 'Reporting and Analytics',
          stories: [
            'تحسين Database Query Performance في شاشة التقارير',
            'Export Reports بصيغة Excel و CSV',
            'إضافة Scheduled Reports ترسل بالبريد أسبوعياً',
            'Dashboard لمتابعة Customer Satisfaction Score',
            'Filters متقدمة في صفحة التقارير',
          ],
        },
      ],
    },
  ],
  'Smart Operations Platform': [
    {
      epic: 'مراقبة العمليات (Operations Monitoring)',
      features: [
        {
          name: 'System Health Monitoring',
          stories: [
            'تمكين فريق العمليات من متابعة System Health بشكل لحظي',
            'عرض Service Status Map لكل البيئات',
            'إضافة Health Checks تلقائية لكل Microservice',
            'تقرير Uptime الشهري لكل خدمة',
          ],
        },
        {
          name: 'Alerting and Incident Management',
          stories: [
            'توجيه Alerts للفريق المسؤول حسب الـ Severity',
            'إنشاء Incident تلقائياً عند تجاوز الـ Threshold',
            'Escalation Policy للحوادث الحرجة',
            'Post-Incident Review Template',
          ],
        },
        {
          name: 'Workflow Automation',
          stories: [
            'أتمتة Approval Workflow لطلبات التغيير',
            'Scheduled Jobs لمهام الصيانة الدورية',
            'Webhook Integration مع نظام التذاكر',
            'Rule Builder لإنشاء قواعد الأتمتة بدون كود',
          ],
        },
      ],
    },
    {
      epic: 'جودة المنصة (Platform Quality)',
      features: [
        {
          name: 'Performance',
          stories: [
            'تقليل Page Load Time للوحة العمليات إلى أقل من ثانيتين',
            'Caching لنتائج الاستعلامات المتكررة',
            'تحسين استهلاك الذاكرة في Background Workers',
          ],
        },
        {
          name: 'Security Hardening',
          stories: [
            'مراجعة Dependencies وإصلاح الثغرات الحرجة',
            'تشفير البيانات الحساسة في Configuration Store',
            'تفعيل Rate Limiting على الـ Public APIs',
          ],
        },
      ],
    },
  ],
  'Enterprise Cloud Platform': [
    {
      epic: 'Cloud Infrastructure Modernization',
      features: [
        {
          name: 'Observability',
          stories: [
            'Distributed Tracing لخدمات المنصة',
            'لوحة Service-Level Objectives لكل خدمة',
            'توحيد Structured Logging عبر كل الخدمات',
            'ربط Alerts بجدول المناوبة (On-Call Rotation)',
          ],
        },
        {
          name: 'CI/CD Pipeline',
          stories: [
            'تشغيل Integration Tests بشكل متوازي في Pipeline',
            'Preview Environments لكل Pull Request',
            'Rollback تلقائي عند فشل Health Checks',
            'تحديث Dependencies تلقائياً للحزم المشتركة',
          ],
        },
      ],
    },
    {
      epic: 'Identity and Access Management',
      features: [
        {
          name: 'Single Sign-On',
          stories: [
            'تفعيل Single Sign-On مع Identity Provider المؤسسي',
            'Session Timeout قابل للإعداد لكل Application',
            'Provisioning تلقائي للمستخدمين الجدد',
          ],
        },
        {
          name: 'Audit and Compliance',
          stories: [
            'Audit Trail لعمليات الدخول والتغييرات الإدارية',
            'Access Review ربع سنوي للصلاحيات',
            'تقرير Compliance قابل للتصدير',
          ],
        },
      ],
    },
  ],
};

const TASK_TEMPLATES = [
  'Implement: {s}',
  'كتابة Unit Tests لـ {s}',
  'Design Review: {s}',
  'تحديث API Endpoints لـ {s}',
  'تحديث Documentation لـ {s}',
  'إضافة Monitoring Metrics لـ {s}',
];

const BUG_TITLES = [
  '[Bug] ظهور رسالة خطأ عند محاولة تسجيل الدخول باستخدام حساب جديد',
  '[Bug] Dashboard لا يعرض البيانات بعد تحديث الصفحة',
  '[Bug] مشكلة في Pagination عند الانتقال للصفحة الأخيرة',
  '[Bug] API Timeout عند تحميل قائمة المستخدمين',
  '[Bug] إجمالي الفاتورة غير صحيح عند استخدام أكثر من عملة',
  '[Bug] إشعار البريد يصل مرتين عند إعادة المحاولة',
  '[Bug] التاريخ يظهر بتوقيت خاطئ في شاشة التقارير',
  '[Bug] Trace ID مفقود من سجلات الـ Background Jobs',
];

const SPIKE_TITLES = [
  'Spike: تقييم Edge Caching للملفات الثابتة',
  'Spike: اختيار Feature Flag Service',
  'Spike: استخدام Event Bus لتتبع دورة حياة الطلب',
];

const TAGS = ['frontend', 'api', 'ux', 'tech-debt', 'security', 'performance', 'accessibility'];

const REPOS = [
  { name: 'portal-web', project: 'Customer Experience Portal' },
  { name: 'portal-api', project: 'Customer Experience Portal' },
  { name: 'operations-app', project: 'Smart Operations Platform' },
  { name: 'cloud-infra', project: 'Enterprise Cloud Platform' },
  { name: 'shared-ui', project: 'Enterprise Cloud Platform' },
];

function slug(s) {
  const out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
  return out || 'update';
}

module.exports = { PEOPLE, TEAMS, BACKLOG, TASK_TEMPLATES, BUG_TITLES, SPIKE_TITLES, TAGS, REPOS, slug };
