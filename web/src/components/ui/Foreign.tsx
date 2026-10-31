interface ForeignProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Optional: the known language of the value, when a caller can say for
   * certain (e.g. a UI-defined enum whose values happen to be English
   * words). Defaults to 'en': every ADO value this app renders through this
   * component that ISN'T free text a person typed (state names, type names,
   * iteration paths, project/repo names) is a literal, always-English
   * process-template or ADO-platform value regardless of which language the
   * UI is in — see docs/invariants.md, "nothing branches on a work
   * item state NAME". Free text (titles, tags) is genuinely unknown and may not be
   * English, but 'en' is still the more common case than its opposite, and
   * `dir="auto"` (not this `lang` attribute) is what keeps the VISUAL
   * direction correct regardless — `lang` only affects how a screen reader
   * pronounces it.
   */
  knownLang?: 'en' | 'ar';
  as?: keyof JSX.IntrinsicElements;
  /** Forwarded to the rendered element as-is — e.g. `href`/`target`/`rel`
   * when `as="a"` replaces a link that used to carry `dir="auto"` directly,
   * or `title` for a native tooltip. Kept loose (not per-tag-typed) so this
   * stays a drop-in replacement for any element that needs foreign-text
   * handling without this file needing to enumerate every intrinsic prop. */
  [key: string]: unknown;
}

/**
 * Renders server-sourced values (work item titles, names, tags, paths, etc.) with
 * the correct direction and language attributes.
 *
 * Sets both `dir="auto"` (for visual rendering, inspecting the actual
 * Unicode content — correct regardless of `knownLang`) and `lang` (for
 * screen readers) so mixed-language lists render correctly and are
 * announced in the right language.
 *
 * Azure DevOps data is never translated — this ensures values remain byte-identical
 * across languages.
 */
export function Foreign({ children, className = '', knownLang = 'en', as: Component = 'span', ...rest }: ForeignProps) {
  return (
    <Component dir="auto" lang={knownLang} className={className} {...rest}>
      {children}
    </Component>
  );
}
