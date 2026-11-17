/** The merchant's in-app application page (0530). Browser-safe: the rep's "copy application link" uses it too. */
export const applyLink = (appUrl: string, applicationToken: string): string =>
  `${appUrl}/apply/${applicationToken}`;
