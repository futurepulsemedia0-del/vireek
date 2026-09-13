export interface AcademyLesson {
  id: string;
  title: string;
  minutes: number;
  videoUrl: string;
  description: string;
}

export interface AcademyCourse {
  slug: string;
  title: string;
  summary: string;
  lessons: AcademyLesson[];
}

/** Replace the placeholder videoUrls with real hosted video before launch. */
export const ACADEMY_COURSES: AcademyCourse[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started with Vireek',
    summary: 'Everything to go from signup to Sarah answering real calls, in under 30 minutes total.',
    lessons: [
      { id: 'welcome', title: 'Welcome & how Vireek fits your business', minutes: 3, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_WELCOME', description: 'A quick tour of what Sarah does on a call and where everything lives in your dashboard.' },
      { id: 'business-profile', title: 'Setting up your Business Profile', minutes: 5, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_PROFILE', description: 'Services, service area, hours, and the emergency policy Sarah follows on every call.' },
      { id: 'call-forwarding', title: 'Forwarding your business number', minutes: 4, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_FORWARDING', description: 'Point your existing number at Vireek without changing what customers dial.' },
      { id: 'first-test-call', title: 'Making your first test call', minutes: 3, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_TESTCALL', description: 'Call in yourself and see exactly what a customer hears and what lands in your dashboard.' },
    ],
  },
  {
    slug: 'running-your-day',
    title: 'Running Your Day with Sarah',
    summary: 'The day-to-day dashboard skills that make the difference between "set up" and "actually using it".',
    lessons: [
      { id: 'dispatch-board', title: 'Reading the Dispatch Board', minutes: 6, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_DISPATCH', description: 'How booked jobs move from "new" to "scheduled" to "done", and where to intervene.' },
      { id: 'price-book', title: 'Setting up your Live Price Book', minutes: 5, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_PRICEBOOK', description: 'Give Sarah real prices to quote on calls instead of promising a callback.' },
      { id: 'reviews-memberships', title: 'Reviews & memberships', minutes: 4, videoUrl: 'https://www.youtube.com/embed/REPLACE_ME_REVIEWS', description: 'Turning finished jobs into 5-star reviews and recurring membership revenue.' },
    ],
  },
];

export function getAllLessonIds(): string[] {
  return ACADEMY_COURSES.flatMap((c) => c.lessons.map((l) => l.id));
}

export function findLesson(lessonId: string): AcademyLesson | undefined {
  for (const course of ACADEMY_COURSES) {
    const lesson = course.lessons.find((l) => l.id === lessonId);
    if (lesson) return lesson;
  }
  return undefined;
}
