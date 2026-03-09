/**
 * Design Tokens Schema
 *
 * Captures every visual constant extracted from the Penpot design:
 * colours, typography scales, spacing, radii, and shadows.
 * Each token includes its Tailwind CSS v4 mapping so the code
 * generator can emit the correct utility classes.
 *
 * JSON files conforming to this schema use:
 *   $schema: "design_tokens"
 *   version: "1.0.0"
 */

// ---------------------------------------------------------------------------
// Schema envelope
// ---------------------------------------------------------------------------

/** Top-level design tokens — one per project. */
export interface DesignTokens {
  /** Schema identifier for JSON validation. */
  readonly $schema: "design_tokens";
  /** Schema version (semver). */
  readonly version: "1.0.0";
  /**
   * Named colour tokens.
   * Key = token name (e.g. "surface-primary", "text-muted").
   */
  colors: Record<string, TokenColor>;
  /**
   * Named typography tokens.
   * Key = token name (e.g. "heading-lg", "body-sm").
   */
  typography: Record<string, TokenTypography>;
  /**
   * Named spacing tokens.
   * Key = token name (e.g. "spacing-xs", "spacing-lg").
   */
  spacing: Record<string, TokenSpacing>;
  /**
   * Named border-radius tokens.
   * Key = token name (e.g. "radius-sm", "radius-full").
   */
  radius: Record<string, TokenRadius>;
  /**
   * Named box-shadow tokens.
   * Key = token name (e.g. "shadow-card", "shadow-dropdown").
   */
  shadows: Record<string, TokenShadow>;
  /**
   * Tailwind CSS v4 mapping configuration.
   * Defines how tokens map to Tailwind's @theme layer.
   */
  tailwindMapping: TailwindMapping;
}

// ---------------------------------------------------------------------------
// Color Token
// ---------------------------------------------------------------------------

/** A colour extracted from the design, with Tailwind + CSS variable mappings. */
export interface TokenColor {
  /** Hex colour value (e.g. "#1E1E2E"). */
  hex: string;
  /** RGB channels — useful for Tailwind's rgba() opacity modifier. */
  rgb: RGBChannels;
  /** Alpha channel (0–1). Present only when the colour is semi-transparent. */
  opacity?: number;
  /**
   * Tailwind utility class that applies this colour.
   * (e.g. "bg-surface-primary", "text-muted").
   */
  tailwindClass: string;
  /**
   * CSS custom property name (e.g. "--color-surface-primary").
   * Used in Tailwind v4's @theme configuration.
   */
  cssVariable: string;
  /** Number of times this colour appears across all pages. */
  occurrences: number;
}

/** Individual R, G, B channel values (0–255). */
export interface RGBChannels {
  r: number;
  g: number;
  b: number;
}

// ---------------------------------------------------------------------------
// Typography Token
// ---------------------------------------------------------------------------

/** A typography style extracted from the design. */
export interface TokenTypography {
  /** Font size (px). */
  fontSize: number;
  /**
   * Font weight (CSS numeric value: 400, 500, 600, 700 …).
   */
  fontWeight: number;
  /** Line height (unitless ratio or px). */
  lineHeight: number;
  /** Letter spacing (em). Present only when non-zero. */
  letterSpacing?: number;
  /** Font family name (e.g. "Inter", "JetBrains Mono"). */
  fontFamily: string;
  /**
   * Tailwind utility classes that reproduce this style.
   * (e.g. ["text-sm", "font-medium", "leading-5"]).
   */
  tailwindClasses: string[];
}

// ---------------------------------------------------------------------------
// Spacing Token
// ---------------------------------------------------------------------------

/** A spacing value extracted from the design (margins, paddings, gaps). */
export interface TokenSpacing {
  /** Spacing value in pixels. */
  px: number;
  /** Equivalent rem value (assuming 16px base). */
  rem: number;
  /**
   * Tailwind utility class (e.g. "gap-4", "p-6").
   * The property prefix (gap, p, m, etc.) depends on usage context.
   */
  tailwindClass: string;
  /** CSS custom property name (e.g. "--spacing-md"). */
  cssVariable: string;
  /** Number of times this spacing value appears across all pages. */
  occurrences: number;
}

// ---------------------------------------------------------------------------
// Radius Token
// ---------------------------------------------------------------------------

/** A border-radius value extracted from the design. */
export interface TokenRadius {
  /** Radius value in pixels. */
  px: number;
  /** Tailwind utility class (e.g. "rounded-lg", "rounded-full"). */
  tailwindClass: string;
  /** CSS custom property name (e.g. "--radius-lg"). */
  cssVariable: string;
  /** Number of times this radius appears across all pages. */
  occurrences: number;
}

// ---------------------------------------------------------------------------
// Shadow Token
// ---------------------------------------------------------------------------

/** A box-shadow value extracted from the design. */
export interface TokenShadow {
  /**
   * CSS box-shadow value string
   * (e.g. "0 4px 6px -1px rgba(0, 0, 0, 0.1)").
   */
  value: string;
  /** Tailwind utility class (e.g. "shadow-md", "shadow-card"). */
  tailwindClass: string;
}

// ---------------------------------------------------------------------------
// Tailwind Mapping
// ---------------------------------------------------------------------------

/**
 * Configuration for mapping design tokens into Tailwind CSS v4's @theme layer.
 * This drives generation of the project's `tailwind.css` / `globals.css`.
 */
export interface TailwindMapping {
  /**
   * Theme colour extensions.
   * Key = Tailwind colour name (e.g. "surface-primary"),
   * Value = CSS variable reference (e.g. "var(--color-surface-primary)").
   */
  colors: Record<string, string>;
  /**
   * Theme font-family extensions.
   * Key = Tailwind font name (e.g. "sans", "mono"),
   * Value = font stack string.
   */
  fontFamily: Record<string, string>;
  /**
   * Theme spacing extensions beyond Tailwind defaults.
   * Key = Tailwind spacing name (e.g. "sidebar", "header"),
   * Value = CSS variable reference or literal value.
   */
  spacing: Record<string, string>;
  /**
   * Theme border-radius extensions.
   * Key = Tailwind radius name (e.g. "card"),
   * Value = CSS variable reference or literal value.
   */
  borderRadius: Record<string, string>;
  /**
   * Theme box-shadow extensions.
   * Key = Tailwind shadow name (e.g. "card"),
   * Value = CSS shadow value string.
   */
  boxShadow: Record<string, string>;
  /**
   * Additional CSS custom properties to inject into :root.
   * Key = variable name (without --), Value = literal value.
   */
  cssVariables: Record<string, string>;
}
