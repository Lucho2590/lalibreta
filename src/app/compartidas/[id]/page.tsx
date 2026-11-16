import { redirect } from "next/navigation";

/** Links viejos (/compartidas/{id}) → detalle del gasto dividido. */
export default async function OldSharedExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/compartidas/gasto/${id}`);
}
