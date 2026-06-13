export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const MAIL_WINDOW_DAYS = 90;
export const DEFAULT_MAIL_QUERY = `newer_than:${MAIL_WINDOW_DAYS}d (in:inbox OR in:sent)`;
