import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowUpRight, CaretDown, Check } from "@phosphor-icons/react";
import { Popover, buttonClassName } from "@read-aware/ui";
import { cn } from "@read-aware/ui/cn";
import { useSiteCopy } from "../i18n/use-site-copy";
import {
  availableLocales,
  isBlogLocale,
  LOCALE_CHOICE_KEY,
  LOCALE_LABEL,
  LOCALE_LANG,
  hasLocaleVariants,
  localizePath,
  servedHref,
  type Locale,
} from "../lib/i18n";
import { CONTACT_EMAIL, DISCORD_URL } from "../lib/site";

/**
 * The header's overflow menu.
 *
 * It exists so the header can stay at four items no matter how much the site
 * grows: everything past Docs / Download / GitHub lands here instead of
 * lengthening the row. That also lets the footer stop repeating the header —
 * this menu, not the footer, is now where the secondary links live.
 *
 * The language switcher lives here too, rather than as a second dropdown
 * beside this one: two carets side by side read as clutter, and switching
 * language was already a click either way. Its section only renders where a
 * translated page actually exists (docs, blog, changelog) — the landing page
 * has no locale variant to switch to.
 *
 * Internal destinations are router Links (client navigation); locale entries
 * are plain anchors (full loads) so each locale boots from its own
 * prerendered HTML; external links carry an arrow so the boundary is visible
 * before the click.
 */
/** Blog mirrors exist only in the three-language subset; pricing and changelog are every locale. */
function moreTo(locale: Locale): {
  blog: string;
  pricing: string;
  changelog: string;
} {
  return {
    blog: isBlogLocale(locale) ? localizePath("/blog", locale) : "/blog",
    pricing: localizePath("/pricing", locale),
    changelog: localizePath("/changelog", locale),
  };
}

const itemClass =
  "flex items-center justify-between gap-3 rounded px-3 py-2 text-[0.9375rem] text-fg-muted transition-colors hover:bg-fill hover:text-fg";

export function MoreMenu({ locale = "en", pathname }: { locale?: Locale; pathname: string }) {
  const explorerQuery = useRouterState({
    select: (state) =>
      state.location.pathname.replace(/\/$/, "").endsWith("/docs/plugins/capabilities") ? state.location.searchStr : "",
  });
  const [open, setOpen] = useState(false);
  const strings = useSiteCopy("chrome");
  const pageLocales = availableLocales(pathname);
  const showLocales = hasLocaleVariants(pathname);

  const close = () => setOpen(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      triggerLabel={strings.more}
      triggerClassName={buttonClassName({ variant: "link", size: "sm" })}
      panelClassName="w-48 p-1"
      trigger={
        <>
          {strings.more}
          <CaretDown
            size={11}
            weight="bold"
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-180")}
          />
        </>
      }
    >
      <Link to={moreTo(locale).pricing} onClick={close} activeProps={{ className: "text-fg" }} className={itemClass}>
        {strings.pricing}
      </Link>
      <Link to={moreTo(locale).blog} onClick={close} activeProps={{ className: "text-fg" }} className={itemClass}>
        {strings.blog}
      </Link>
      <Link to={moreTo(locale).changelog} onClick={close} activeProps={{ className: "text-fg" }} className={itemClass}>
        {strings.changelog}
      </Link>
      <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" onClick={close} className={itemClass}>
        Discord
        <ArrowUpRight size={13} aria-hidden="true" className="shrink-0" />
      </a>
      {/* No "Release notes" entry: it would sit one row under Changelog
              pointing at nearly the same thing. The changelog page links to
              the GitHub release per version and in full at the bottom, which
              is where someone who wants the complete record is already looking. */}
      <a href={`mailto:${CONTACT_EMAIL}`} onClick={close} className={itemClass}>
        Email
      </a>

      {showLocales && (
        <>
          <div className="my-1 border-t border-border" />
          <p className="px-3 pb-1 pt-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            {strings.language}
          </p>
          {pageLocales.map((target) => (
            <a
              key={target}
              href={`${servedHref(localizePath(pathname, target))}${explorerQuery}`}
              lang={LOCALE_LANG[target]}
              onClick={() => {
                // An explicit pick outranks the homepage's Accept-Language
                // redirect on every future visit.
                try {
                  localStorage.setItem(LOCALE_CHOICE_KEY, target);
                } catch {
                  // Storage unavailable — the pick still applies this visit.
                }
                close();
              }}
              className={cn(itemClass, target === locale && "text-fg")}
            >
              <span>{LOCALE_LABEL[target]}</span>
              {target === locale && <Check size={14} weight="bold" aria-hidden="true" className="shrink-0" />}
            </a>
          ))}
        </>
      )}
    </Popover>
  );
}
