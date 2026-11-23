"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CheckCircle2, CreditCard, Plus, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CategorySelect } from "@/components/category-select";
import { useAccounts, useCategories } from "@/hooks/use-data";
import { apiJson } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  isCreditLine,
  isPaymentLine,
  type ImportLine,
  type ImportPayload,
  type ImportResult,
  type StatementAnalysis,
} from "@/lib/domain/statement-import";
import { zeroMoney, type Category } from "@/lib/domain/types";

const fmtDate = (ymd: string | null) => (ymd ? ymd.split("-").reverse().slice(0, 2).join("/") : "—");

type Row = ImportLine & { touched: boolean };
type Filter = "all" | "uncategorized" | "duplicates";

export function StatementReview({
  analysis,
  preselectedAccountId,
  onImported,
  onCancel,
}: {
  analysis: StatementAnalysis;
  preselectedAccountId?: string | null;
  onImported: (r: ImportResult) => void;
  onCancel: () => void;
}) {
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const cards = accounts.filter((a) => a.type === "credit" && a.active !== false);
  const parents = accounts.filter(
    (a) => a.type !== "credit" && a.type !== "reserve" && !a.parentId && a.active !== false,
  );
  const expenseCats = categories.filter((c) => c.kind === "expense");
  const accountItems = [
    ...cards.map((c) => ({ value: c.id, label: c.last4 ? `${c.name} ···· ${c.last4}` : c.name })),
    { value: "new", label: "Crear tarjeta nueva" },
  ];
  const parentItems = [
    { value: "none", label: "Sin cuenta" },
    ...parents.map((p) => ({ value: p.id, label: p.name })),
  ];

  const [accountChoice, setAccountChoice] = useState<string>(
    analysis.matchedAccountId ?? preselectedAccountId ?? "new",
  );
  const [newName, setNewName] = useState(analysis.card.suggestedName);
  const [parentId, setParentId] = useState("");
  const [rows, setRows] = useState<Row[]>(() =>
    analysis.lines.map((l) => ({
      ...l,
      include: !isPaymentLine(l) && !l.duplicateOf,
      categoryId: l.suggestedCategoryId,
      touched: false,
    })),
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);

  const visible = rows.filter((r) =>
    filter === "uncategorized"
      ? r.include && !r.categoryId
      : filter === "duplicates"
        ? !!r.duplicateOf
        : true,
  );

  const totals = useMemo(() => {
    const t = zeroMoney();
    let count = 0;
    for (const r of rows) {
      if (!r.include || isPaymentLine(r)) continue;
      t[r.currency] += r.amount;
      count += 1;
    }
    return { ...t, count };
  }, [rows]);
  const uncategorized = rows.filter((r) => r.include && !isPaymentLine(r) && !r.categoryId).length;
  const duplicates = rows.filter((r) => r.duplicateOf).length;

  /** Cambia la categoría de una fila y la copia a las del mismo comercio que no tocaste. */
  const setCategory = (index: number, categoryId: string) => {
    setRows((prev) => {
      const target = prev.find((r) => r.index === index)!;
      return prev.map((r) => {
        if (r.index === index) return { ...r, categoryId: categoryId || null, touched: true };
        if (!r.touched && r.merchantKey && r.merchantKey === target.merchantKey) {
          return { ...r, categoryId: categoryId || null };
        }
        return r;
      });
    });
  };

  const setInclude = (index: number, include: boolean) =>
    setRows((prev) => prev.map((x) => (x.index === index ? { ...x, include } : x)));

  /** Marca o desmarca un consumo como "se repite todos los meses". */
  const toggleRecurring = (index: number) =>
    setRows((prev) =>
      prev.map((x) =>
        x.index === index ? { ...x, type: x.type === "subscription" ? "purchase" : "subscription" } : x,
      ),
    );

  const bulkCategory = (categoryId: string) => {
    if (!categoryId) return;
    const kind = categories.find((c) => c.id === categoryId)?.kind;
    setRows((prev) =>
      prev.map((r) =>
        selected.has(r.index) && !isPaymentLine(r) && kind === "expense"
          ? { ...r, categoryId, touched: true }
          : r,
      ),
    );
    setSelected(new Set());
  };

  const bulkInclude = (include: boolean) => {
    setRows((prev) =>
      prev.map((r) => (selected.has(r.index) && !isPaymentLine(r) ? { ...r, include } : r)),
    );
    setSelected(new Set());
  };

  const toggleSelected = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const submit = async () => {
    if (accountChoice === "new" && !newName.trim()) {
      toast.error("Poné un nombre para la tarjeta nueva");
      return;
    }
    setBusy(true);
    try {
      const payload: ImportPayload = {
        account:
          accountChoice === "new"
            ? { newName: newName.trim(), parentId: parentId || null }
            : { existingId: accountChoice },
        last4: analysis.card.last4,
        closingDate: analysis.closingDate,
        dueDate: analysis.dueDate,
        nextClosingDate: analysis.nextClosingDate,
        nextDueDate: analysis.nextDueDate,
        totalARS: analysis.totalARS,
        totalUSD: analysis.totalUSD,
        minimumPayment: analysis.minimumPayment,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        lines: rows.map(({ touched, ...l }) => l),
      };
      const result = await apiJson<ImportResult>("/api/statements/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      onImported(result);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo importar el resumen");
    } finally {
      setBusy(false);
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.index));

  return (
    <div className="space-y-5">
      {/* Tarjeta y datos del resumen */}
      <Card className="rounded-3xl">
        <CardContent className="grid gap-5 py-5 md:grid-cols-[1.4fr_1fr]">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CreditCard className="size-4" />
              Tarjeta
              {analysis.card.last4 && (
                <span className="font-normal text-muted-foreground">···· {analysis.card.last4}</span>
              )}
              {analysis.matchedAccountId && accountChoice === analysis.matchedAccountId && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                  detectada
                </span>
              )}
            </div>
            <Select value={accountChoice} onValueChange={(v) => setAccountChoice(String(v ?? "new"))}>
              <SelectTrigger className="h-10 w-full bg-background">
                <SelectValue items={accountItems} placeholder="Elegí la tarjeta" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start">
                {cards.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <CreditCard className="text-muted-foreground" />
                    {c.name}
                    {c.last4 ? <span className="text-muted-foreground">···· {c.last4}</span> : null}
                  </SelectItem>
                ))}
                {cards.length > 0 && <SelectSeparator />}
                <SelectItem value="new">
                  <Plus className="text-muted-foreground" />
                  Crear tarjeta nueva
                </SelectItem>
              </SelectContent>
            </Select>
            {accountChoice === "new" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="new-card">Nombre</Label>
                  <Input id="new-card" value={newName} onChange={(e) => setNewName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-parent">Cuenta asociada (opcional)</Label>
                  <Select value={parentId || "none"} onValueChange={(v) => setParentId(v === "none" ? "" : String(v ?? ""))}>
                    <SelectTrigger id="new-parent" className="h-9 w-full bg-background">
                      <SelectValue items={parentItems} />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false} align="start">
                      <SelectItem value="none">Sin cuenta</SelectItem>
                      {parents.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {analysis.matchedAccountId && accountChoice !== analysis.matchedAccountId && (
              <p className="text-xs text-amber-600">
                Ojo: los &quot;ya cargado&quot; se calcularon para la tarjeta detectada.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Cierre" value={fmtDate(analysis.closingDate)} />
            <Info label="Vence" value={fmtDate(analysis.dueDate)} />
            <Info
              label="Total del resumen"
              value={[
                formatMoney(analysis.totalARS, "ARS"),
                analysis.totalUSD ? formatMoney(analysis.totalUSD, "USD") : null,
              ]
                .filter(Boolean)
                .join(" + ")}
            />
            {analysis.nextClosingDate && (
              <Info
                label="Próximo"
                value={`cierra ${fmtDate(analysis.nextClosingDate)} · vence ${fmtDate(analysis.nextDueDate)}`}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Barra de filtros y acciones en lote */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full gap-1 rounded-xl bg-muted p-1 text-sm md:w-auto">
          {(
            [
              ["all", "Todos", rows.length],
              ["uncategorized", "Sin categoría", uncategorized],
              ["duplicates", "Ya cargados", duplicates],
            ] as Array<[Filter, string, number]>
          ).map(([f, label, n]) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 font-medium transition md:flex-none md:px-3 ${
                filter === f ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {label} ({n})
            </button>
          ))}
        </div>
        {selected.size > 0 && (
          <div className="hidden items-center gap-2 rounded-xl border bg-background px-3 py-1.5 text-sm md:flex">
            <span className="text-muted-foreground">{selected.size} seleccionados</span>
            <CategorySelect
              className="w-56"
              value={null}
              placeholder="Asignar categoría…"
              onChange={bulkCategory}
              groups={[
                { label: "Gastos", categories: expenseCats },
              ]}
            />
            <Button size="sm" variant="ghost" onClick={() => bulkInclude(true)}>
              Cargar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => bulkInclude(false)}>
              No cargar
            </Button>
          </div>
        )}
      </div>

      {/* Celu: un consumo por tarjetita */}
      <div className="space-y-2 md:hidden">
        {visible.map((r) => {
          const payment = isPaymentLine(r);
          const muted = !r.include || payment;
          return (
            <Card key={r.index} className={`rounded-2xl py-0 ${muted ? "opacity-70" : ""}`}>
              <CardContent className="space-y-2.5 px-3 py-3">
                <div className="flex items-start gap-3">
                  {payment ? (
                    <span className="mt-0.5 w-9 shrink-0 text-center text-[11px] text-muted-foreground">pago</span>
                  ) : (
                    <label className="-m-2 flex shrink-0 cursor-pointer items-center justify-center p-2">
                      <input
                        type="checkbox"
                        className="size-5 cursor-pointer rounded accent-brand"
                        aria-label="Cargar este consumo"
                        checked={r.include}
                        onChange={(e) => setInclude(r.index, e.target.checked)}
                      />
                    </label>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`min-w-0 break-words text-sm ${r.include && !payment ? "font-medium" : "text-muted-foreground"}`}
                      >
                        {r.description}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(r.amount, r.currency)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">{fmtDate(r.date)}</span>
                      <LineBadges row={r} accountChoice={accountChoice} onToggleRecurring={toggleRecurring} />
                    </div>
                  </div>
                </div>
                {payment ? (
                  <p className="text-xs text-muted-foreground">Es un pago: no se carga.</p>
                ) : (
                  <RowCategory
                    row={r}
                    categories={expenseCats}
                    onChange={(id) => setCategory(r.index, id)}
                    className="h-10"
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
        {visible.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">Nada para mostrar con este filtro.</p>
        )}
      </div>

      {/* Compu: tabla de consumos */}
      <Card className="hidden overflow-hidden rounded-3xl md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer rounded accent-brand"
                  aria-label="Seleccionar todos"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.index)))
                  }
                />
              </th>
              <th className="w-16 px-2 py-2">Cargar</th>
              <th className="w-16 px-2 py-2">Fecha</th>
              <th className="px-2 py-2">Consumo</th>
              <th className="w-36 px-2 py-2 text-right">Monto</th>
              <th className="w-64 px-3 py-2">Categoría</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const payment = isPaymentLine(r);
              return (
                <tr
                  key={r.index}
                  className={`border-b last:border-0 ${!r.include || payment ? "text-muted-foreground" : ""} ${
                    selected.has(r.index) ? "bg-brand/5" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                  className="size-4 cursor-pointer rounded accent-brand"
                      aria-label="Seleccionar"
                      checked={selected.has(r.index)}
                      onChange={() => toggleSelected(r.index)}
                    />
                  </td>
                  <td className="px-2 py-2">
                    {payment ? (
                      <span className="text-[11px]">pago</span>
                    ) : (
                      <input
                        type="checkbox"
                  className="size-4 cursor-pointer rounded accent-brand"
                        aria-label="Cargar este consumo"
                        checked={r.include}
                        onChange={(e) => setInclude(r.index, e.target.checked)}
                      />
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{fmtDate(r.date)}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={r.include ? "font-medium text-foreground" : ""}>{r.description}</span>
                      <LineBadges row={r} accountChoice={accountChoice} onToggleRecurring={toggleRecurring} />
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                  <td className="px-3 py-2">
                    {payment ? (
                      <span className="text-xs">no se carga</span>
                    ) : (
                      <RowCategory row={r} categories={expenseCats} onChange={(id) => setCategory(r.index, id)} />
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Nada para mostrar con este filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <CheckCircle2 className="size-3.5 text-emerald-600" /> aprendida de tus resúmenes anteriores
        </span>
        <span className="flex items-center gap-1">
          <Sparkles className="size-3.5 text-brand" /> sugerida por la IA
        </span>
        <span className="flex items-center gap-1">
          <Wand2 className="size-3.5" /> al elegir una, se copia a los consumos del mismo comercio
        </span>
      </p>

      {/* Pie */}
      <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex flex-col gap-3 rounded-2xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur md:bottom-4 md:flex-row md:items-center md:justify-between md:gap-4 md:px-5">
        <div className="text-sm">
          <span className="font-semibold">{totals.count} consumos</span>
          <span className="text-muted-foreground">
            {" "}
            · {formatMoney(totals.ARS, "ARS")}
            {totals.USD ? ` + ${formatMoney(totals.USD, "USD")}` : ""} a cargar
          </span>
          {uncategorized > 0 && (
            <span className="ml-2 text-amber-600">· {uncategorized} sin categoría (van a &quot;Otros&quot;)</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1 md:flex-none" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="flex-1 bg-brand-grad text-white hover:opacity-95 md:flex-none"
            onClick={submit}
            disabled={busy || totals.count === 0}
          >
            {busy ? "Importando…" : "Importar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** Chips de un consumo: cuota, reintegro, "se repite" y "ya cargado". */
function LineBadges({
  row: r,
  accountChoice,
  onToggleRecurring,
}: {
  row: Row;
  accountChoice: string;
  onToggleRecurring: (index: number) => void;
}) {
  const payment = isPaymentLine(r);
  const credit = isCreditLine(r);
  return (
    <>
      {r.installmentNumber && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
          cuota {r.installmentNumber}/{r.installmentsTotal}
        </span>
      )}
      {credit && (
        <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
          reintegro
        </span>
      )}
      {/* Ya es uno de sus fijos: se engancha solo (el mes que viene lo pone el fijo). */}
      {r.recurringId && (
        <span
          className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand"
          title="Es uno de tus fijos: lo reconocí por cómo figura en el resumen"
        >
          🔁 fijo{r.recurringName ? `: ${r.recurringName}` : ""}
        </span>
      )}
      {/* Servicios y suscripciones que se debitan todos los meses: se estiman
          en el resumen siguiente (y se reemplazan por el real al importarlo). */}
      {!r.recurringId && !payment && !credit && !r.installmentNumber && r.amount > 0 &&
        (r.type === "purchase" || r.type === "subscription" || r.type === "other") && (
          <button
            type="button"
            onClick={() => onToggleRecurring(r.index)}
            title={
              r.type === "subscription"
                ? "Se repite todos los meses: lo estimo en el próximo resumen. Tocá para sacarlo."
                : "¿Se debita todos los meses (servicio, seguro, suscripción)? Tocá para estimarlo en el próximo resumen."
            }
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium transition ${
              r.type === "subscription"
                ? "bg-brand/10 text-brand"
                : "border border-dashed text-muted-foreground hover:bg-muted"
            }`}
          >
            {r.type === "subscription" ? "🔁 se repite" : "🔁 ¿todos los meses?"}
          </button>
        )}
      {r.duplicateOf && (
        <Link
          href={`/movimientos?account=${accountChoice}`}
          className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:underline"
          title="Ya hay un movimiento igual en la tarjeta"
        >
          ya cargado
        </Link>
      )}
    </>
  );
}

/** Selector de categoría de un consumo, con la marca de dónde salió la sugerencia. */
function RowCategory({
  row: r,
  categories,
  onChange,
  className,
}: {
  row: Row;
  categories: Category[];
  onChange: (categoryId: string) => void;
  className?: string;
}) {
  const suggested = !r.touched && r.categoryId === r.suggestedCategoryId;
  return (
    <div className="flex items-center gap-1.5">
      <CategorySelect
        value={r.categoryId}
        onChange={onChange}
        groups={[{ categories }]}
        placeholder="Elegí…"
        warn={r.include}
        className={className}
      />
      {suggested && r.categorySource === "rule" && (
        <span title="La elegiste vos en un resumen anterior" className="shrink-0 text-emerald-600">
          <CheckCircle2 className="size-4" />
        </span>
      )}
      {suggested && r.categorySource === "ai" && (
        <span title="Sugerida por la IA" className="shrink-0 text-brand">
          <Sparkles className="size-4" />
        </span>
      )}
    </div>
  );
}
