"use client";

import { AnimatedMoney } from "@/components/motion/animated-money";
import type { PersonBalance } from "./balance-text";

/** "Te debe $X" / "Le debés $X" / "Están a mano", con los montos animados. */
export function PersonBalanceText({ balance: b }: { balance: PersonBalance }) {
  if (b.kind === "owes") return <>Te debe <AnimatedMoney amounts={b.amounts.owes} /></>;
  if (b.kind === "iOwe") return <>Le debés <AnimatedMoney amounts={b.amounts.iOwe} /></>;
  if (b.kind === "both") {
    return (
      <>
        Te debe <AnimatedMoney amounts={b.amounts.owes} /> · le debés <AnimatedMoney amounts={b.amounts.iOwe} />
      </>
    );
  }
  return <>{b.text}</>;
}

/** "$X de cuotas que vienen · vos le debés $Y de cuotas que vienen", animado. Nada si no hay. */
export function PersonLaterText({ balance: b }: { balance: PersonBalance }) {
  const toMe = Object.keys(b.amounts.laterToMe).length > 0;
  const iOwe = Object.keys(b.amounts.laterIOwe).length > 0;
  if (!toMe && !iOwe) return null;
  return (
    <>
      {toMe && (
        <>
          <AnimatedMoney amounts={b.amounts.laterToMe} /> de cuotas que vienen
        </>
      )}
      {toMe && iOwe && " · "}
      {iOwe && (
        <>
          vos le debés <AnimatedMoney amounts={b.amounts.laterIOwe} /> de cuotas que vienen
        </>
      )}
    </>
  );
}
