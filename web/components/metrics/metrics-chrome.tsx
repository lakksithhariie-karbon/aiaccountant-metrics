"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const SECTION_ITEMS = ["Overview", "Engineering & Delivery", "Product", "AI Services", "Business"] as const;
const CURRENT_SECTION = "Product";

type MetricsPage = "overview" | "retention";

export function MetricsChrome({
  active,
  extraLockScroll = false,
  overlays,
  children,
}: {
  active: MetricsPage;
  extraLockScroll?: boolean;
  overlays?: ReactNode;
  children: ReactNode;
}) {
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const menuCloseTimer = useRef<number | null>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const menuCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("metrics-no-scroll", menuOpen || extraLockScroll);
    return () => document.body.classList.remove("metrics-no-scroll");
  }, [extraLockScroll, menuOpen]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    if (menuCloseTimer.current) window.clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = window.setTimeout(() => {
      setMenuMounted(false);
      menuCloseTimer.current = null;
    }, 240);
  }, []);

  const openMenu = useCallback(() => {
    if (menuCloseTimer.current) window.clearTimeout(menuCloseTimer.current);
    setMenuMounted(true);
    window.requestAnimationFrame(() => setMenuOpen(true));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const focusMenu = window.requestAnimationFrame(() => menuCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMenu, menuOpen]);

  useEffect(() => () => {
    if (menuCloseTimer.current) window.clearTimeout(menuCloseTimer.current);
  }, []);

  const toggleTheme = () => {
    const nextDark = !dark;
    setDark(nextDark);
    document.documentElement.classList.toggle("dark", nextDark);
  };

  return (
    <div className="metrics-page">
      <div className="metrics-frame">
        <header className="metrics-topbar">
          <div className="metrics-brand">
            <Button
              className="metrics-menu-trigger"
              variant="topbarPlain"
              size="icon"
              type="button"
              aria-label={menuOpen ? "Close sections menu" : "Open sections menu"}
              aria-expanded={menuOpen}
              aria-controls="sections-menu"
              onClick={menuOpen ? closeMenu : openMenu}
            >
              <Menu aria-hidden="true" />
            </Button>
            <span className="metrics-brand-strong">AI Accountant</span>
            <span className="metrics-brand-separator" aria-hidden="true" />
            <span className="metrics-brand-sub">Product Metrics</span>
          </div>
          <div className="metrics-top-right">
            <Button
              variant={active === "overview" ? "topbarActive" : "topbar"}
              size="topbar"
              asChild
            >
              <Link href="/overview" aria-current={active === "overview" ? "page" : undefined}>
                Overview
              </Link>
            </Button>
            <Button
              variant={active === "retention" ? "topbarActive" : "topbar"}
              size="topbar"
              asChild
            >
              <Link href="/" aria-current={active === "retention" ? "page" : undefined}>
                Retention
              </Link>
            </Button>
            <Button variant="topbar" size="topbar" type="button" aria-pressed={dark} onClick={toggleTheme}>
              {dark ? "Light" : "Dark"}
            </Button>
          </div>
        </header>
        {children}
      </div>

      {menuMounted ? (
        <aside
          ref={menuRef}
          id="sections-menu"
          className={cn("metrics-section-menu", menuOpen && "open")}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sections-menu-title"
        >
          <div className="metrics-section-menu-head">
            <div className="metrics-section-menu-brand">
              <span id="sections-menu-title" className="metrics-section-menu-title">AI Accountant</span>
              <span className="metrics-section-menu-context">Product Metrics</span>
            </div>
            <Button ref={menuCloseRef} variant="topbar" size="icon" type="button" aria-label="Close sections menu" onClick={closeMenu}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="metrics-section-menu-main">
            <p className="metrics-section-menu-kicker">Sections</p>
            <nav className="metrics-section-items" aria-label="Sections">
              {SECTION_ITEMS.map((item) => (
                <button
                  className={cn("metrics-section-item", item === CURRENT_SECTION && "active", item !== CURRENT_SECTION && "placeholder")}
                  type="button"
                  aria-current={item === CURRENT_SECTION ? "page" : undefined}
                  aria-disabled={item !== CURRENT_SECTION}
                  key={item}
                  onClick={closeMenu}
                >
                  {item}
                </button>
              ))}
            </nav>
          </div>
        </aside>
      ) : null}

      {overlays}
    </div>
  );
}
