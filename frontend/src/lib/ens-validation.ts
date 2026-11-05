import { normalize } from "viem/ens";
export function registrationName(input: string) {
  const name = normalize(
    input.trim().toLowerCase().endsWith(".eth")
      ? input.trim()
      : `${input.trim()}.eth`,
  );
  const parts = name.split(".");
  if (
    parts.length !== 2 ||
    parts[1] !== "eth" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(parts[0])
  )
    throw new Error(
      "Choose a .eth name with 3–63 lowercase letters, numbers or internal hyphens.",
    );
  return name;
}
