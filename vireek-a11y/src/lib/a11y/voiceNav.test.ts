import { describe, expect, it } from 'vitest';
import { normalizeSpeech, parseVoiceCommand } from './voiceNav';

describe('parseVoiceCommand', () => {
  it('English commands (whole-utterance only)', () => {
    expect(parseVoiceCommand('Scroll down.', 'en')).toEqual({ type: 'scroll', dir: 'down' });
    expect(parseVoiceCommand('please stop', 'en')).toEqual({ type: 'stop' });
    expect(parseVoiceCommand('next heading', 'en')).toEqual({ type: 'heading', dir: 'next' });
    expect(parseVoiceCommand('I will scroll down later', 'en')).toBe(null);
    expect(parseVoiceCommand('', 'en')).toBe(null);
  });
  it('click with target (prefix) and unknown speech', () => {
    expect(parseVoiceCommand('click Sign up', 'en')).toEqual({ type: 'click', target: 'sign up' });
    expect(parseVoiceCommand('open pricing', 'en')).toEqual({ type: 'click', target: 'pricing' });
    expect(parseVoiceCommand('click', 'en')).toBe(null);
  });
  it('Persian: ZWNJ/space variants, suffix click', () => {
    expect(parseVoiceCommand('برو پایین', 'fa')).toEqual({ type: 'scroll', dir: 'down' });
    expect(parseVoiceCommand('بزرگ‌تر', 'fa')).toEqual({ type: 'textSize', dir: 'up' });
    expect(parseVoiceCommand('بزرگ تر', 'fa')).toEqual({ type: 'textSize', dir: 'up' });
    expect(parseVoiceCommand('قیمت‌ها را باز کن', 'fa')).toEqual({ type: 'click', target: 'قیمت ها' });
    expect(parseVoiceCommand('کلیک ثبت نام', 'fa')).toEqual({ type: 'click', target: 'ثبت نام' });
  });
  it('Arabic: letter variants and prefix click', () => {
    expect(parseVoiceCommand('انزل', 'ar')).toEqual({ type: 'scroll', dir: 'down' });
    expect(parseVoiceCommand('اقرأ', 'ar')).toEqual({ type: 'read' });
    expect(parseVoiceCommand('اضغط تسجيل الدخول', 'ar')).toEqual({ type: 'click', target: 'تسجیل الدخول' });
  });
  it('normalizeSpeech unifies Arabic/Persian forms', () => {
    expect(normalizeSpeech('كتاب')).toBe(normalizeSpeech('کتاب'));
  });
});
