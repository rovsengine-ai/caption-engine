import type { Transcript } from '../types.js';

/**
 * Offline sample transcript for Demo mode (no ASR keys required).
 * Kept as a TS module so it ships with `tsc` output without a separate copy step.
 */
export const DEMO_TRANSCRIPT: Transcript = {
  words: [
    { text: 'Aap', start: 0.12, end: 0.32, confidence: 0.96, type: 'word', keep: true, language: 'hi', roman: 'Aap' },
    { text: 'sabhi', start: 0.34, end: 0.62, confidence: 0.95, type: 'word', keep: true, language: 'hi', roman: 'sabhi' },
    { text: 'logon', start: 0.64, end: 0.98, confidence: 0.94, type: 'word', keep: true, language: 'hi', roman: 'logon' },
    { text: 'ko', start: 1.05, end: 1.18, confidence: 0.97, type: 'word', keep: true, language: 'hi', roman: 'ko' },
    { text: 'Shri', start: 1.22, end: 1.48, confidence: 0.93, type: 'word', keep: true, language: 'hi', roman: 'Shri' },
    { text: 'Krishna', start: 1.5, end: 1.92, confidence: 0.95, type: 'word', keep: true, language: 'hi', roman: 'Krishna' },
    { text: 'Janmashtami', start: 2.0, end: 2.7, confidence: 0.94, type: 'word', keep: true, language: 'hi', roman: 'Janmashtami' },
    { text: 'ki', start: 2.78, end: 2.92, confidence: 0.96, type: 'word', keep: true, language: 'hi', roman: 'ki' },
    { text: 'dheron', start: 2.98, end: 3.35, confidence: 0.92, type: 'word', keep: true, language: 'hi', roman: 'dheron' },
    { text: 'saari', start: 3.4, end: 3.72, confidence: 0.93, type: 'word', keep: true, language: 'hi', roman: 'saari' },
    { text: 'badhaiyan', start: 3.78, end: 4.35, confidence: 0.94, type: 'word', keep: true, language: 'hi', roman: 'badhaiyan' },
    { text: 'aur', start: 4.5, end: 4.7, confidence: 0.96, type: 'word', keep: true, language: 'hi', roman: 'aur' },
    { text: 'shubhkamnayein', start: 4.78, end: 5.55, confidence: 0.91, type: 'word', keep: true, language: 'hi', roman: 'shubhkamnayein' },
    { text: 'Happy', start: 5.8, end: 6.1, confidence: 0.97, type: 'word', keep: true, language: 'en', roman: 'Happy' },
    { text: 'Janmashtami', start: 6.15, end: 6.85, confidence: 0.95, type: 'word', keep: true, language: 'hi', roman: 'Janmashtami' },
    { text: 'to', start: 6.9, end: 7.05, confidence: 0.98, type: 'word', keep: true, language: 'en', roman: 'to' },
    { text: 'everyone', start: 7.1, end: 7.55, confidence: 0.96, type: 'word', keep: true, language: 'en', roman: 'everyone' },
    { text: 'watching', start: 7.6, end: 8.1, confidence: 0.95, type: 'word', keep: true, language: 'en', roman: 'watching' },
  ],
  language: 'hi',
  duration: 8.4,
  provider: 'demo',
  model: 'offline-sample',
  hasWordTimings: true,
  detectedLanguageRaw: 'hin',
  warnings: ['Demo / offline sample transcript — not from a live ASR provider.'],
};
