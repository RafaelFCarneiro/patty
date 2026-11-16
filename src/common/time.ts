export const sleep = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));
