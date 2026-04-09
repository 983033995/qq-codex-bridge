export type ComposerButtonCandidate = {
  text: string;
  aria: string | null;
  title: string | null;
  className: string;
};

export function isLikelyComposerSubmitButton(candidate: ComposerButtonCandidate): boolean {
  const explicitSendLabel = /send|发送|submit|开始构建|构建|继续|resume|run/i;
  const primaryComposerButtonClass = /\bsize-token-button-composer\b/i;
  const filledPrimaryButtonClass = /\bbg-token-foreground\b/i;
  const label = `${candidate.text} ${candidate.aria ?? ""} ${candidate.title ?? ""}`.trim();
  if (explicitSendLabel.test(label)) {
    return true;
  }

  return (
    primaryComposerButtonClass.test(candidate.className) &&
    filledPrimaryButtonClass.test(candidate.className)
  );
}
