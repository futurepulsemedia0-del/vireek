/* ------------------------------------------------------------------ */
/*  i18n — Multilingual Accessibility Engine                           */
/* ------------------------------------------------------------------ */

export type LanguageCode =
  | 'en' | 'es' | 'zh' | 'hi' | 'fr' | 'de' | 'ar' | 'fa' | 'ja';

export type TextDirection = 'ltr' | 'rtl';

export interface Language {
  code: LanguageCode;
  name: string;
  nativeName: string;
  flag: string;
  direction: TextDirection;
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English',            nativeName: 'English',     flag: '🇺🇸', direction: 'ltr' },
  { code: 'es', name: 'Spanish',            nativeName: 'Español',     flag: '🇪🇸', direction: 'ltr' },
  { code: 'zh', name: 'Chinese Simplified',  nativeName: '简体中文',     flag: '🇨🇳', direction: 'ltr' },
  { code: 'hi', name: 'Hindi',              nativeName: 'हिन्दी',      flag: '🇮🇳', direction: 'ltr' },
  { code: 'fr', name: 'French',             nativeName: 'Français',    flag: '🇫🇷', direction: 'ltr' },
  { code: 'de', name: 'German',             nativeName: 'Deutsch',     flag: '🇩🇪', direction: 'ltr' },
  { code: 'ar', name: 'Arabic',             nativeName: 'العربية',      flag: '🇸🇦', direction: 'rtl' },
  { code: 'fa', name: 'Persian',            nativeName: 'فارسی',       flag: '🇮🇷', direction: 'rtl' },
  { code: 'ja', name: 'Japanese',           nativeName: '日本語',       flag: '🇯🇵', direction: 'ltr' },
];

export const RTL_LANGUAGES = LANGUAGES.filter((l) => l.direction === 'rtl').map((l) => l.code);

export function getLanguage(code: LanguageCode): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export function isRTL(code: LanguageCode): boolean {
  return getLanguage(code).direction === 'rtl';
}

/* ------------------------------------------------------------------ */
/*  Translation keys                                                   */
/* ------------------------------------------------------------------ */

export type TranslationKey =
  | 'accessibilityCenter'
  | 'customizeExperience'
  | 'accessibilityScore'
  | 'optimized'
  | 'quickActions'
  | 'smartSuggestions'
  | 'profiles'
  | 'vision'
  | 'color'
  | 'reading'
  | 'motion'
  | 'navigation'
  | 'language'
  | 'assistant'
  | 'reset'
  | 'resetAll'
  | 'autoSaved'
  | 'close'
  | 'openAccessibility'
  | 'chooseExperience'
  | 'aiRecommendation'
  | 'basedOnPreferences'
  | 'applyRecommendation'
  | 'searchLanguages'
  | 'recentlyUsed'
  | 'allLanguages'
  | 'languageExperience'
  | 'readingComfort'
  | 'visualComfort'
  | 'navigationComfort'
  | 'personalizationLevel'
  | 'globalEasyMode'
  | 'seniorWorldwideMode'
  | 'lowVisionMode'
  | 'readingComfortMode'
  | 'focusMode'
  | 'distractionFreeMode'
  | 'languageLearningMode'
  | 'makeEasier'
  | 'simplifyText'
  | 'voiceReady'
  | 'voiceNavReady'
  | 'textToSpeechReady'
  | 'multiLanguageVoice';

type TranslationMap = Record<TranslationKey, string>;

/* ------------------------------------------------------------------ */
/*  Translations for all 9 languages                                   */
/* ------------------------------------------------------------------ */

export const TRANSLATIONS: Record<LanguageCode, TranslationMap> = {
  en: {
    accessibilityCenter: 'Accessibility Center',
    customizeExperience: 'Customize your experience',
    accessibilityScore: 'Accessibility Score',
    optimized: 'optimized',
    quickActions: 'Quick Actions',
    smartSuggestions: 'Smart Suggestions',
    profiles: 'Profiles',
    vision: 'Vision',
    color: 'Color',
    reading: 'Reading',
    motion: 'Motion',
    navigation: 'Navigation',
    language: 'Language',
    assistant: 'Assistant',
    reset: 'Reset',
    resetAll: 'Reset All',
    autoSaved: 'Auto-saved',
    close: 'Close',
    openAccessibility: 'Open accessibility center',
    chooseExperience: 'Choose Your Perfect Experience',
    aiRecommendation: 'AI Recommendation',
    basedOnPreferences: 'Based on your device and preferences, we recommend:',
    applyRecommendation: 'Apply Recommendation',
    searchLanguages: 'Search languages...',
    recentlyUsed: 'Recently Used',
    allLanguages: 'All Languages',
    languageExperience: 'Language Experience',
    readingComfort: 'Reading Comfort',
    visualComfort: 'Visual Comfort',
    navigationComfort: 'Navigation Comfort',
    personalizationLevel: 'Personalization Level',
    globalEasyMode: 'Global Easy Mode',
    seniorWorldwideMode: 'Senior Worldwide Mode',
    lowVisionMode: 'Low Vision Mode',
    readingComfortMode: 'Reading Comfort Mode',
    focusMode: 'Focus Mode',
    distractionFreeMode: 'Distraction Free Mode',
    languageLearningMode: 'Language Learning Mode',
    makeEasier: 'Make this easier to understand',
    simplifyText: 'AI simplifies complex content into clearer language',
    voiceReady: 'Voice Navigation Ready',
    voiceNavReady: 'Voice commands architecture prepared',
    textToSpeechReady: 'Text-to-Speech Ready',
    multiLanguageVoice: 'Multi-language voice support planned',
  },
  es: {
    accessibilityCenter: 'Centro de Accesibilidad',
    customizeExperience: 'Personaliza tu experiencia',
    accessibilityScore: 'Puntuación de Accesibilidad',
    optimized: 'optimizado',
    quickActions: 'Acciones Rápidas',
    smartSuggestions: 'Sugerencias Inteligentes',
    profiles: 'Perfiles',
    vision: 'Visión',
    color: 'Color',
    reading: 'Lectura',
    motion: 'Movimiento',
    navigation: 'Navegación',
    language: 'Idioma',
    assistant: 'Asistente',
    reset: 'Restablecer',
    resetAll: 'Restablecer Todo',
    autoSaved: 'Guardado automático',
    close: 'Cerrar',
    openAccessibility: 'Abrir centro de accesibilidad',
    chooseExperience: 'Elige Tu Experiencia Perfecta',
    aiRecommendation: 'Recomendación de IA',
    basedOnPreferences: 'Según tu dispositivo y preferencias, recomendamos:',
    applyRecommendation: 'Aplicar Recomendación',
    searchLanguages: 'Buscar idiomas...',
    recentlyUsed: 'Usados Recientemente',
    allLanguages: 'Todos los Idiomas',
    languageExperience: 'Experiencia de Idioma',
    readingComfort: 'Comodidad de Lectura',
    visualComfort: 'Comodidad Visual',
    navigationComfort: 'Comodidad de Navegación',
    personalizationLevel: 'Nivel de Personalización',
    globalEasyMode: 'Modo Fácil Global',
    seniorWorldwideMode: 'Modo Senior Mundial',
    lowVisionMode: 'Modo Baja Visión',
    readingComfortMode: 'Modo Comodidad de Lectura',
    focusMode: 'Modo Enfoque',
    distractionFreeMode: 'Modo Sin Distracciones',
    languageLearningMode: 'Modo Aprendizaje de Idiomas',
    makeEasier: 'Hacer esto más fácil de entender',
    simplifyText: 'La IA simplifica contenido complejo a lenguaje más claro',
    voiceReady: 'Navegación por Voz Lista',
    voiceNavReady: 'Arquitectura de comandos de voz preparada',
    textToSpeechReady: 'Texto a Voz Listo',
    multiLanguageVoice: 'Soporte de voz multilingüe planificado',
  },
  zh: {
    accessibilityCenter: '无障碍中心',
    customizeExperience: '自定义您的体验',
    accessibilityScore: '无障碍评分',
    optimized: '已优化',
    quickActions: '快速操作',
    smartSuggestions: '智能建议',
    profiles: '配置文件',
    vision: '视觉',
    color: '颜色',
    reading: '阅读',
    motion: '动画',
    navigation: '导航',
    language: '语言',
    assistant: '助手',
    reset: '重置',
    resetAll: '全部重置',
    autoSaved: '自动保存',
    close: '关闭',
    openAccessibility: '打开无障碍中心',
    chooseExperience: '选择您的完美体验',
    aiRecommendation: 'AI 推荐',
    basedOnPreferences: '根据您的设备和偏好，我们推荐：',
    applyRecommendation: '应用推荐',
    searchLanguages: '搜索语言...',
    recentlyUsed: '最近使用',
    allLanguages: '所有语言',
    languageExperience: '语言体验',
    readingComfort: '阅读舒适度',
    visualComfort: '视觉舒适度',
    navigationComfort: '导航舒适度',
    personalizationLevel: '个性化程度',
    globalEasyMode: '全球简易模式',
    seniorWorldwideMode: '全球长者模式',
    lowVisionMode: '低视力模式',
    readingComfortMode: '阅读舒适模式',
    focusMode: '专注模式',
    distractionFreeMode: '无干扰模式',
    languageLearningMode: '语言学习模式',
    makeEasier: '让这更容易理解',
    simplifyText: 'AI 将复杂内容简化为更清晰的语言',
    voiceReady: '语音导航就绪',
    voiceNavReady: '语音命令架构已准备',
    textToSpeechReady: '文字转语音就绪',
    multiLanguageVoice: '多语言语音支持计划中',
  },
  hi: {
    accessibilityCenter: 'सुलभता केंद्र',
    customizeExperience: 'अपना अनुभव अनुकूलित करें',
    accessibilityScore: 'सुलभता स्कोर',
    optimized: 'अनुकूलित',
    quickActions: 'त्वरित क्रियाएं',
    smartSuggestions: 'स्मार्ट सुझाव',
    profiles: 'प्रोफाइल',
    vision: 'दृष्टि',
    color: 'रंग',
    reading: 'पठन',
    motion: 'गति',
    navigation: 'नेविगेशन',
    language: 'भाषा',
    assistant: 'सहायक',
    reset: 'रीसेट',
    resetAll: 'सभी रीसेट करें',
    autoSaved: 'स्वतः सहेजा गया',
    close: 'बंद करें',
    openAccessibility: 'सुलभता केंद्र खोलें',
    chooseExperience: 'अपना एकदम सही अनुभव चुनें',
    aiRecommendation: 'AI अनुशंसा',
    basedOnPreferences: 'आपके डिवाइस और प्राथमिकताओं के आधार पर, हम अनुशंसा करते हैं:',
    applyRecommendation: 'अनुशंसा लागू करें',
    searchLanguages: 'भाषाएं खोजें...',
    recentlyUsed: 'हाल ही में उपयोग की गई',
    allLanguages: 'सभी भाषाएं',
    languageExperience: 'भाषा अनुभव',
    readingComfort: 'पठन आराम',
    visualComfort: 'दृश्य आराम',
    navigationComfort: 'नेविगेशन आराम',
    personalizationLevel: 'वैयक्तिकरण स्तर',
    globalEasyMode: 'वैश्विक आसान मोड',
    seniorWorldwideMode: 'वरिष्ठ वैश्विक मोड',
    lowVisionMode: 'कम दृष्टि मोड',
    readingComfortMode: 'पठन आराम मोड',
    focusMode: 'फोकस मोड',
    distractionFreeMode: 'विकर्षण मुक्त मोड',
    languageLearningMode: 'भाषा सीखने का मोड',
    makeEasier: 'इसे समझना आसान बनाएं',
    simplifyText: 'AI जटिल सामग्री को स्पष्ट भाषा में सरल बनाता है',
    voiceReady: 'वॉइस नेविगेशन तैयार',
    voiceNavReady: 'वॉइस कमांड आर्किटेक्चर तैयार',
    textToSpeechReady: 'टेक्स्ट-टू-स्पीच तैयार',
    multiLanguageVoice: 'बहुभाषी वॉइस समर्थन योजन�बद्ध',
  },
  fr: {
    accessibilityCenter: "Centre d'Accessibilité",
    customizeExperience: 'Personnalisez votre expérience',
    accessibilityScore: "Score d'Accessibilité",
    optimized: 'optimisé',
    quickActions: 'Actions Rapides',
    smartSuggestions: 'Suggestions Intelligentes',
    profiles: 'Profils',
    vision: 'Vision',
    color: 'Couleur',
    reading: 'Lecture',
    motion: 'Mouvement',
    navigation: 'Navigation',
    language: 'Langue',
    assistant: 'Assistant',
    reset: 'Réinitialiser',
    resetAll: 'Tout Réinitialiser',
    autoSaved: 'Sauvegarde auto',
    close: 'Fermer',
    openAccessibility: "Ouvrir le centre d'accessibilité",
    chooseExperience: 'Choisissez Votre Expérience Parfaite',
    aiRecommendation: 'Recommandation IA',
    basedOnPreferences: 'Selon votre appareil et préférences, nous recommandons :',
    applyRecommendation: 'Appliquer la Recommandation',
    searchLanguages: 'Rechercher des langues...',
    recentlyUsed: 'Récemment Utilisées',
    allLanguages: 'Toutes les Langues',
    languageExperience: 'Expérience Linguistique',
    readingComfort: 'Confort de Lecture',
    visualComfort: 'Confort Visuel',
    navigationComfort: 'Confort de Navigation',
    personalizationLevel: 'Niveau de Personnalisation',
    globalEasyMode: 'Mode Facile Global',
    seniorWorldwideMode: 'Mode Senior Mondial',
    lowVisionMode: 'Mode Basse Vision',
    readingComfortMode: 'Mode Confort de Lecture',
    focusMode: 'Mode Concentration',
    distractionFreeMode: 'Mode Sans Distraction',
    languageLearningMode: "Mode Apprentissage des Langues",
    makeEasier: 'Rendre plus facile à comprendre',
    simplifyText: "L'IA simplifie le contenu complexe en langage plus clair",
    voiceReady: 'Navigation Vocale Prête',
    voiceNavReady: 'Architecture des commandes vocales préparée',
    textToSpeechReady: 'Synthèse Vocale Prête',
    multiLanguageVoice: 'Support vocal multilingue planifié',
  },
  de: {
    accessibilityCenter: 'Barrierefreiheitszentrum',
    customizeExperience: 'Passen Sie Ihre Erfahrung an',
    accessibilityScore: 'Barrierefreiheits-Score',
    optimized: 'optimiert',
    quickActions: 'Schnellaktionen',
    smartSuggestions: 'Intelligente Vorschläge',
    profiles: 'Profile',
    vision: 'Sehen',
    color: 'Farbe',
    reading: 'Lesen',
    motion: 'Bewegung',
    navigation: 'Navigation',
    language: 'Sprache',
    assistant: 'Assistent',
    reset: 'Zurücksetzen',
    resetAll: 'Alle zurücksetzen',
    autoSaved: 'Auto-gespeichert',
    close: 'Schließen',
    openAccessibility: 'Barrierefreiheitszentrum öffnen',
    chooseExperience: 'Wählen Sie Ihr perfektes Erlebnis',
    aiRecommendation: 'KI-Empfehlung',
    basedOnPreferences: 'Basierend auf Ihrem Gerät und Ihren Einstellungen empfehlen wir:',
    applyRecommendation: 'Empfehlung anwenden',
    searchLanguages: 'Sprachen suchen...',
    recentlyUsed: 'Zuletzt verwendet',
    allLanguages: 'Alle Sprachen',
    languageExperience: 'Spracherfahrung',
    readingComfort: 'Lesekomfort',
    visualComfort: 'Visueller Komfort',
    navigationComfort: 'Navigationskomfort',
    personalizationLevel: 'Personalisierungsgrad',
    globalEasyMode: 'Globaler Einfacher Modus',
    seniorWorldwideMode: 'Weltweiter Senior-Modus',
    lowVisionMode: 'Modus für Sehschwäche',
    readingComfortMode: 'Lesekomfort-Modus',
    focusMode: 'Fokus-Modus',
    distractionFreeMode: 'Ablenkungsfreier Modus',
    languageLearningMode: 'Sprachlern-Modus',
    makeEasier: 'Leichter verständlich machen',
    simplifyText: 'KI vereinfacht komplexe Inhalte in klarere Sprache',
    voiceReady: 'Sprachnavigation bereit',
    voiceNavReady: 'Sprachbefehls-Architektur vorbereitet',
    textToSpeechReady: 'Text-to-Speech bereit',
    multiLanguageVoice: 'Mehrsprachige Sprachunterstützung geplant',
  },
  ar: {
    accessibilityCenter: 'مركز إمكانية الوصول',
    customizeExperience: 'خصص تجربتك',
    accessibilityScore: 'نتيجة إمكانية الوصول',
    optimized: 'محسّن',
    quickActions: 'إجراءات سريعة',
    smartSuggestions: 'اقتراحات ذكية',
    profiles: 'ملفات تعريف',
    vision: 'الرؤية',
    color: 'اللون',
    reading: 'القراءة',
    motion: 'الحركة',
    navigation: 'التنقل',
    language: 'اللغة',
    assistant: 'المساعد',
    reset: 'إعادة تعيين',
    resetAll: 'إعادة تعيين الكل',
    autoSaved: 'حفظ تلقائي',
    close: 'إغلاق',
    openAccessibility: 'فتح مركز إمكانية الوصول',
    chooseExperience: 'اختر تجربتك المثالية',
    aiRecommendation: 'توصية الذكاء الاصطناعي',
    basedOnPreferences: 'بناءً على جهازك وتفضيلاتك، نوصي بـ:',
    applyRecommendation: 'تطبيق التوصية',
    searchLanguages: 'البحث عن اللغات...',
    recentlyUsed: 'المستخدمة مؤخراً',
    allLanguages: 'جميع اللغات',
    languageExperience: 'تجربة اللغة',
    readingComfort: 'راحة القراءة',
    visualComfort: 'الراحة البصرية',
    navigationComfort: 'راحة التنقل',
    personalizationLevel: 'مستوى التخصيص',
    globalEasyMode: 'الوضع السهل العالمي',
    seniorWorldwideMode: 'وضع كبار السن العالمي',
    lowVisionMode: 'وضع ضعف البصر',
    readingComfortMode: 'وضع راحة القراءة',
    focusMode: 'وضع التركيز',
    distractionFreeMode: 'وضع خالٍ من التشتيت',
    languageLearningMode: 'وضع تعلم اللغة',
    makeEasier: 'اجعل هذا أسهل للفهم',
    simplifyText: 'يبسط الذكاء الاصطناعي المحتوى المعقد إلى لغة أوضح',
    voiceReady: 'التنقل الصوتي جاهز',
    voiceNavReady: 'تم إعداد بنية أوامر الصوت',
    textToSpeechReady: 'تحويل النص إلى كلام جاهز',
    multiLanguageVoice: 'دعم صوتي متعدد اللغات مخطط له',
  },
  fa: {
    accessibilityCenter: 'مرکز دسترسی‌پذیری',
    customizeExperience: 'تجربه خود را سفارشی کنید',
    accessibilityScore: 'امتیاز دسترسی‌پذیری',
    optimized: 'بهینه‌شده',
    quickActions: 'اقدامات سریع',
    smartSuggestions: 'پیشنهادات هوشمند',
    profiles: 'پروفایل‌ها',
    vision: 'بینایی',
    color: 'رنگ',
    reading: 'مطالعه',
    motion: 'حرکت',
    navigation: 'ناوبری',
    language: 'زبان',
    assistant: 'دستیار',
    reset: 'بازنشانی',
    resetAll: 'بازنشانی همه',
    autoSaved: 'ذخیره خودکار',
    close: 'بستن',
    openAccessibility: 'باز کردن مرکز دسترسی‌پذیری',
    chooseExperience: 'تجربه ایده‌آل خود را انتخاب کنید',
    aiRecommendation: 'توصیه هوش مصنوعی',
    basedOnPreferences: 'بر اساس دستگاه و ترجیحات شما، توصیه می‌کنیم:',
    applyRecommendation: 'اعمال توصیه',
    searchLanguages: 'جستجوی زبان‌ها...',
    recentlyUsed: 'اخیراً استفاده شده',
    allLanguages: 'همه زبان‌ها',
    languageExperience: 'تجربه زبانی',
    readingComfort: 'راحت مطالعه',
    visualComfort: 'راحت بصری',
    navigationComfort: 'راحت ناوبری',
    personalizationLevel: 'سطح شخصی‌سازی',
    globalEasyMode: 'حالت آسان جهانی',
    seniorWorldwideMode: 'حالت سالمندان جهانی',
    lowVisionMode: 'حاخت ضعف بینایی',
    readingComfortMode: 'حالت راحتی مطالعه',
    focusMode: 'حالت تمرکز',
    distractionFreeMode: 'حالت بدون حواس‌پرتی',
    languageLearningMode: 'حالت یادگیری زبان',
    makeEasier: 'این را آسان‌تر برای درک کنید',
    simplifyText: 'هوش مصنوعی محتوای پیچیده را به زبان واضح‌تر ساده می‌کند',
    voiceReady: 'ناوبری صوتی آماده',
    voiceNavReady: 'ساختار فرمان صوتی آماده شد',
    textToSpeechReady: 'متن به گفتار آماده',
    multiLanguageVoice: 'پشتیبانی صوتی چندزبانه برنامه‌ریزی شده',
  },
  ja: {
    accessibilityCenter: 'アクセシビリティセンター',
    customizeExperience: 'エクスペリエンスをカスタマイズ',
    accessibilityScore: 'アクセシビリティスコア',
    optimized: '最適化済み',
    quickActions: 'クイックアクション',
    smartSuggestions: 'スマート提案',
    profiles: 'プロファイル',
    vision: '視覚',
    color: 'カラー',
    reading: '読書',
    motion: 'モーション',
    navigation: 'ナビゲーション',
    language: '言語',
    assistant: 'アシスタント',
    reset: 'リセット',
    resetAll: 'すべてリセット',
    autoSaved: '自動保存',
    close: '閉じる',
    openAccessibility: 'アクセシビリティセンターを開く',
    chooseExperience: '完璧なエクスペリエンスを選択',
    aiRecommendation: 'AI推奨',
    basedOnPreferences: 'お使いのデバイスと設定に基づいて、以下を推奨します：',
    applyRecommendation: '推奨を適用',
    searchLanguages: '言語を検索...',
    recentlyUsed: '最近使用したもの',
    allLanguages: 'すべての言語',
    languageExperience: '言語エクスペリエンス',
    readingComfort: '読書の快適さ',
    visualComfort: '視覚の快適さ',
    navigationComfort: 'ナビゲーションの快適さ',
    personalizationLevel: 'パーソナライズレベル',
    globalEasyMode: 'グローバルイージーモード',
    seniorWorldwideMode: 'シニアワールドワイドモード',
    lowVisionMode: 'ロービジョンモード',
    readingComfortMode: '読書快適モード',
    focusMode: 'フォーカスモード',
    distractionFreeMode: '気散らしフリーモード',
    languageLearningMode: '言語学習モード',
    makeEasier: 'これを理解しやすくする',
    simplifyText: 'AIが複雑なコンテンツをより明確な言葉に簡略化',
    voiceReady: '音声ナビゲーション準備完了',
    voiceNavReady: '音声コマンドアーキテクチャ準備済み',
    textToSpeechReady: 'テキスト読み上げ準備完了',
    multiLanguageVoice: '多言語音声サポート計画中',
  },
};

/* ------------------------------------------------------------------ */
/*  Global accessibility profiles                                      */
/* ------------------------------------------------------------------ */

export interface GlobalProfile {
  id: string;
  nameKey: TranslationKey;
  description: string;
  icon: string;
  settings: Partial<Record<string, unknown>>;
}

export const GLOBAL_PROFILES: GlobalProfile[] = [
  {
    id: 'global-easy',
    nameKey: 'globalEasyMode',
    description: 'Simplified interface with larger text and clear navigation.',
    icon: 'globe',
    settings: { textSize: 1.15, lineHeight: 1.8, readableFont: true, strongFocus: true, highlightLinks: true },
  },
  {
    id: 'senior-worldwide',
    nameKey: 'seniorWorldwideMode',
    description: 'Maximum readability with large text and high contrast.',
    icon: 'user',
    settings: { textSize: 1.3, lineHeight: 1.9, readableFont: true, highContrast: true, strongFocus: true, largeCursor: true, highlightLinks: true },
  },
  {
    id: 'low-vision-global',
    nameKey: 'lowVisionMode',
    description: 'Enhanced contrast, large cursor, and bold focus indicators.',
    icon: 'eye',
    settings: { textSize: 1.2, highContrast: true, largeCursor: true, strongFocus: true, highlightLinks: true, highlightHeadings: true },
  },
  {
    id: 'reading-comfort-global',
    nameKey: 'readingComfortMode',
    description: 'Optimized line spacing, letter spacing, and reading width.',
    icon: 'book',
    settings: { lineHeight: 1.9, letterSpacing: 0.04, wordSpacing: 0.08, readableFont: true, readingMode: true, textSize: 1.1 },
  },
  {
    id: 'focus-global',
    nameKey: 'focusMode',
    description: 'Reduced distractions with reading mode and highlighted structure.',
    icon: 'target',
    settings: { readingMode: true, highlightHeadings: true, reduceMotion: true },
  },
  {
    id: 'distraction-free',
    nameKey: 'distractionFreeMode',
    description: 'Minimal animations, hidden images, and clean layout.',
    icon: 'minimize',
    settings: { reduceMotion: true, stopAnimations: true, hideImages: true, readingMode: true },
  },
  {
    id: 'language-learning',
    nameKey: 'languageLearningMode',
    description: 'Clear typography and spacing for language learners.',
    icon: 'book',
    settings: { lineHeight: 2.0, letterSpacing: 0.06, wordSpacing: 0.1, readableFont: true, textSize: 1.1 },
  },
];
