import { redirect } from "next/navigation";
export default function Page() {
  redirect(process.env.NEXT_PUBLIC_ADMIN_URL || "http://127.0.0.1:3001");
}
