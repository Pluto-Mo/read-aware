import { Component, lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, BracketsCurly, SquaresFour } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useCapabilityExplorer, useManifestDraft } from "../hooks/useCapabilityExplorer";
import { localizePath, localeFromPathname, servedHref } from "../lib/i18n";
import { CapabilityBrowserSlot } from "./PluginDocTools";
import "./capability-explorer.css";

const PermissionPreviewSlot = lazy(() => import("./PluginPermissionPreviewSlot"));

export function PluginCapabilitiesPage() {
  const { t } = useTranslation("docs");
  const { search, pathname } = useCapabilityExplorer();
  const title = t("pages.pluginsCapabilities.body").split("\n")[0].replace(/^#\s+/, "");
  const locale = localeFromPathname(pathname);
  const manifest = search.view === "manifest";
  const [manifestSource, setManifestSource] = useManifestDraft(t("sampleManifest"));
  return (
    <article className="explorer-page">
      <header className="explorer-heading">
        <div>
          <h1>{title}</h1>
          <p>{t("explorer.intro")}</p>
        </div>
        <a className="explorer-guide" href={servedHref(localizePath("/docs/plugins/develop", locale))}>
          {t("explorer.buildGuide")}
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      </header>
      <nav className="explorer-mode-nav" aria-label={title}>
        <Link
          to={pathname as never}
          search={{ ...search, view: undefined } as never}
          activeOptions={{ exact: true, explicitUndefined: true }}
          aria-current={!manifest ? "page" : undefined}
          resetScroll={false}
        >
          <SquaresFour size={17} aria-hidden="true" />
          {t("explorer.browse")}
        </Link>
        <Link
          to={pathname as never}
          search={{ ...search, view: "manifest" } as never}
          activeOptions={{ exact: true, explicitUndefined: true }}
          aria-current={manifest ? "page" : undefined}
          resetScroll={false}
        >
          <BracketsCurly size={17} aria-hidden="true" />
          {t("explorer.checkManifest")}
        </Link>
      </nav>
      {manifest ? (
        <div className="manifest-workspace">
          <p className="explorer-manifest-intro">{t("explorer.manifestIntro")}</p>
          <EditorBoundary
            fallback={
              <p role="alert">
                {t("explorer.loadError")}{" "}
                <button type="button" className="explorer-text-button" onClick={() => window.location.reload()}>
                  {t("explorer.reload")}
                </button>
              </p>
            }
          >
            <Suspense fallback={<p role="status">{t("permissionPreview.inputLabel")}…</p>}>
              <PermissionPreviewSlot source={manifestSource} onChange={setManifestSource} />
            </Suspense>
          </EditorBoundary>
        </div>
      ) : (
        <CapabilityBrowserSlot />
      )}
      <footer className="explorer-footer">
        <span>{t("explorer.versionNote")}</span>
        <a href={servedHref(localizePath("/docs/plugins/api", locale))}>
          {t("explorer.apiGuide")}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </footer>
    </article>
  );
}

class EditorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
