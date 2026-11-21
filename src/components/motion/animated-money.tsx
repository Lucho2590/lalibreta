"use client";

import { Fragment } from "react";
import { AnimatedNumber } from "./animated-number";
import { formatMoney } from "@/lib/format";
import type { Currency } from "@/lib/domain/types";

const CURS: Currency[] = ["ARS", "USD"];
const formatters: Record<Currency, (n: number) => string> = {
  ARS: (n) => formatMoney(n, "ARS"),
  USD: (n) => formatMoney(n, "USD"),
};

/**
 * "$ 1.000 + US$ 20" con cada número animado (cuenta hasta el valor nuevo).
 * Muestra el valor absoluto de cada moneda que no sea cero; si son todas
 * cero, "$ 0".
 */
export function AnimatedMoney({ amounts }: { amounts: Partial<Record<Currency, number>> }) {
  const shown = CURS.filter((c) => Math.abs(amounts[c] ?? 0) > 0.009);
  if (shown.length === 0) return <AnimatedNumber value={0} format={formatters.ARS} />;
  return (
    <>
      {shown.map((c, i) => (
        <Fragment key={c}>
          {i > 0 && " + "}
          <AnimatedNumber value={Math.abs(amounts[c] ?? 0)} format={formatters[c]} />
        </Fragment>
      ))}
    </>
  );
}

/** Un monto en una moneda (con su signo), animado. */
export function AnimatedAmount({ value, currency }: { value: number; currency: Currency }) {
  return <AnimatedNumber value={value} format={formatters[currency]} />;
}
