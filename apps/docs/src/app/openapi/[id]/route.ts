import { openapi } from "@/lib/openapi";

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return Response.json((await openapi.getSchema((await params).id)).bundled);
}

export async function generateStaticParams() {
  return Object.keys(await openapi.getSchemas()).map((id) => ({ id }));
}
