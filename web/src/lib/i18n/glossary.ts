/**
 * Terminology Glossary — Phase 6 (US4)
 *
 * One Arabic term per concept across the entire application. Entries include:
 * - concept: stable English identifier (used in code/comments)
 * - en: English term as used in the interface
 * - ar: Arabic term (single, definitive)
 * - convention: translate / transliterate / keep-english
 * - note: reasoning for contested choices
 */

export const glossary = [
  {
    concept: 'sprint',
    en: 'Sprint',
    ar: 'الدورة',
    convention: 'translate',
    note: 'Modern Standard Arabic term for a time-boxed iteration.',
  },
  {
    concept: 'iteration',
    en: 'Iteration',
    ar: 'الدورة',
    convention: 'translate',
    note: 'Same as sprint in this context.',
  },
  {
    concept: 'story',
    en: 'Story',
    ar: 'قصة',
    convention: 'translate',
    note: 'User story. "القصة" is the standard term.',
  },
  {
    concept: 'task',
    en: 'Task',
    ar: 'مهمة',
    convention: 'translate',
    note: 'Work item type.',
  },
  {
    concept: 'bug',
    en: 'Bug',
    ar: 'خطأ',
    convention: 'translate',
    note: 'Defect or bug.',
  },
  {
    concept: 'state',
    en: 'State',
    ar: 'الحالة',
    convention: 'translate',
    note: 'Work item state/status.',
  },
  {
    concept: 'hours',
    en: 'Hours',
    ar: 'الساعات',
    convention: 'translate',
    note: 'Time tracking unit.',
  },
  {
    concept: 'remaining-work',
    en: 'Remaining work',
    ar: 'العمل المتبقي',
    convention: 'translate',
    note: 'Effort estimate.',
  },
  {
    concept: 'estimate',
    en: 'Estimate',
    ar: 'التقدير',
    convention: 'translate',
    note: 'Story point or hour estimate.',
  },
  {
    concept: 'velocity',
    en: 'Velocity',
    ar: 'السرعة',
    convention: 'translate',
    note: 'Sprint velocity metric.',
  },
  {
    concept: 'burndown',
    en: 'Burndown',
    ar: 'تخفيض العبء',
    convention: 'translate',
    note: 'Burndown chart term.',
  },
  {
    concept: 'capacity',
    en: 'Capacity',
    ar: 'السعة',
    convention: 'translate',
    note: 'Team capacity/availability.',
  },
  {
    concept: 'utilisation',
    en: 'Utilisation',
    ar: 'الاستخدام',
    convention: 'translate',
    note: 'Resource utilisation.',
  },
  {
    concept: 'impediment',
    en: 'Impediment',
    ar: 'العقبة',
    convention: 'translate',
    note: 'Blocker or obstacle.',
  },
  {
    concept: 'blocked',
    en: 'Blocked',
    ar: 'محظور',
    convention: 'translate',
    note: 'State meaning blocked.',
  },
  {
    concept: 'scope-change',
    en: 'Scope change',
    ar: 'تغيير النطاق',
    convention: 'translate',
    note: 'Work added/removed from sprint.',
  },
  {
    concept: 'pull-request',
    en: 'Pull Request',
    ar: 'طلب السحب',
    convention: 'translate',
    note: 'Code review request.',
  },
  {
    concept: 'review',
    en: 'Review',
    ar: 'المراجعة',
    convention: 'translate',
    note: 'Code review.',
  },
  {
    concept: 'repository',
    en: 'Repository',
    ar: 'المستودع',
    convention: 'translate',
    note: 'Git repository.',
  },
  {
    concept: 'branch',
    en: 'Branch',
    ar: 'الفرع',
    convention: 'translate',
    note: 'Git branch.',
  },
  {
    concept: 'team',
    en: 'Team',
    ar: 'الفريق',
    convention: 'translate',
    note: 'Organizational team.',
  },
  {
    concept: 'role',
    en: 'Role',
    ar: 'الدور',
    convention: 'translate',
    note: 'User role in the system.',
  },
  {
    concept: 'project',
    en: 'Project',
    ar: 'المشروع',
    convention: 'translate',
    note: 'Azure DevOps project.',
  },
] as const;
