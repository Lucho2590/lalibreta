import { ImageResponse } from "next/og";

/**
 * Ícono de La Libreta (la billetera de la barra lateral sobre el degradé de la
 * marca), dibujado con ImageResponse para no tener que mantener PNGs.
 *
 * - `rounded`: esquinas redondeadas con fondo transparente (escritorio, favicon).
 * - sin redondear: cuadrado lleno (iOS y Android le aplican su propia máscara).
 *   El dibujo ocupa el 50 % del centro, dentro de la zona segura de los maskable.
 */
const WALLET_SVG = (stroke: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>`,
  )}`;

export const BRAND_COLOR = "#5b3fd6";

export const renderAppIcon = (size: number, { rounded = false }: { rounded?: boolean } = {}) =>
  new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: rounded ? size * 0.22 : 0,
          background: "linear-gradient(135deg, #7a4fe8 0%, #5b3fd6 50%, #3f3cc4 100%)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={WALLET_SVG("#ffffff")} width={size * 0.5} height={size * 0.5} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
