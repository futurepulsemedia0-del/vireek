// Demo copy for stories, in English (LTR) and Persian (RTL). Stories read it through demo(globals),
// so flipping the toolbar's Direction control swaps the text as well as the layout.
export type Direction = 'ltr' | 'rtl';

export type DemoKey =
  | 'save' | 'cancel' | 'remove' | 'edit' | 'add' | 'settings' | 'noPermission'
  | 'name' | 'email' | 'emailHint' | 'emailError' | 'search'
  | 'city' | 'cityHint' | 'cityA' | 'cityB' | 'cityC'
  | 'notify' | 'notifyHint' | 'terms' | 'termsHint' | 'termsError'
  | 'cardTitle' | 'cardBody' | 'revenue' | 'revenueValue' | 'revenueDefinition' | 'tooltip'
  | 'online' | 'pending' | 'warning' | 'failed' | 'live' | 'idle';

const en: Record<DemoKey, string> = {
  save: 'Save changes', cancel: 'Cancel', remove: 'Delete', edit: 'Edit', add: 'Add', settings: 'Settings',
  noPermission: 'Only an admin can do this.',
  name: 'Name', email: 'Email', emailHint: 'Used to send receipts.', emailError: 'Enter a valid email address.',
  search: 'Search customers',
  city: 'City', cityHint: 'Where the service is performed.', cityA: 'Austin', cityB: 'Denver', cityC: 'Phoenix',
  notify: 'SMS notifications', notifyHint: 'Texts the customer before the technician arrives.',
  terms: 'I accept the terms', termsHint: 'Required to continue.', termsError: 'You must accept to continue.',
  cardTitle: 'Job #1248', cardBody: 'AC repair, tomorrow at 10:00.',
  revenue: 'Monthly revenue', revenueValue: '$12,480', revenueDefinition: 'Sum of paid invoices this month.',
  tooltip: 'This action cannot be undone.',
  online: 'Online', pending: 'Pending', warning: 'Needs review', failed: 'Failed', live: 'Live', idle: 'Idle',
};

const fa: Record<DemoKey, string> = {
  save: 'ذخیره تغییرات', cancel: 'انصراف', remove: 'حذف', edit: 'ویرایش', add: 'افزودن', settings: 'تنظیمات',
  noPermission: 'فقط مدیر می‌تواند این کار را انجام دهد.',
  name: 'نام', email: 'ایمیل', emailHint: 'برای ارسال رسید استفاده می‌شود.', emailError: 'نشانی ایمیل معتبر نیست.',
  search: 'جستجوی مشتری',
  city: 'شهر', cityHint: 'شهر محل ارائهٔ خدمت.', cityA: 'تهران', cityB: 'اصفهان', cityC: 'شیراز',
  notify: 'اعلان پیامکی', notifyHint: 'قبل از رسیدن تکنسین برای مشتری پیامک ارسال می‌شود.',
  terms: 'شرایط را می‌پذیرم', termsHint: 'برای ادامه لازم است.', termsError: 'برای ادامه باید بپذیرید.',
  cardTitle: 'کار شمارهٔ ۱۲۴۸', cardBody: 'تعمیر کولر گازی، فردا ساعت ۱۰ صبح.',
  revenue: 'درآمد ماه', revenueValue: '۱۲٬۴۸۰٬۰۰۰ ریال', revenueDefinition: 'مجموع فاکتورهای پرداخت‌شده در این ماه.',
  tooltip: 'این اقدام قابل بازگشت نیست.',
  online: 'آنلاین', pending: 'در انتظار', warning: 'نیازمند بررسی', failed: 'ناموفق', live: 'زنده', idle: 'بیکار',
};

export const demoText: Record<Direction, Record<DemoKey, string>> = { ltr: en, rtl: fa };

/** Pass the story context's `globals`. Anything other than direction === 'rtl' is English. */
export const demo = (globals: Record<string, unknown>): Record<DemoKey, string> =>
  demoText[globals.direction === 'rtl' ? 'rtl' : 'ltr'];
