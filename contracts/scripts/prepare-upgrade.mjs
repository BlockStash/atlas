import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { deploymentGasLimit, deploymentError } from "./deployment-utils.mjs";
async function main() {
  const [fqn, reference, referenceDir] = process.argv.slice(2);
  if (!fqn || !reference || !referenceDir || !fqn.includes(":"))
    throw Error(
      "Usage: npm run upgrade:prepare -- <source.sol:ContractName> <old-release:source.sol:OldContract> </path/to/old-release>",
    );
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@openzeppelin/upgrades-core/dist/cli/cli.js",
      "validate",
      "out/build-info",
      "--contract",
      fqn,
      "--reference",
      reference,
      "--referenceBuildInfoDirs",
      referenceDir,
      "--requireReference",
    ],
    { stdio: "inherit", cwd: new URL("../", import.meta.url) },
  );
  if (result.status !== 0)
    throw Error("Upgrade validation failed; nothing was deployed.");
  if (!process.env.DEPLOYER_PRIVATE_KEY)
    throw Error(
      "Configure the dedicated DEPLOYER_PRIVATE_KEY in contracts/.env.",
    );
  const [source, name] = fqn.split(":");
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))
    throw Error("Invalid contract name.");
  const artifact = JSON.parse(
    await readFile(
      new URL(`../out/${basename(source)}/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, {
    cacheTimeout: -1,
  });
  if ((await provider.getNetwork()).chainId !== 11155111n)
    throw Error("Upgrade preparation supports Sepolia only.");
  const signer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider),
    factory = new ContractFactory(
      artifact.abi,
      artifact.bytecode.object,
      signer,
    );
  const request = await factory.getDeployTransaction();
  const gasLimit = await deploymentGasLimit(provider, {
    ...request,
    from: signer.address,
  });
  const implementation = await factory.deploy({ gasLimit });
  console.log(
    `Implementation submitted: ${implementation.deploymentTransaction().hash}`,
  );
  await implementation.waitForDeployment();
  console.log(`Validated implementation: ${await implementation.getAddress()}`);
  console.log(
    "No proxy was upgraded. Review this implementation in Market Control with the selected country owner.",
  );
  provider.destroy();
}
main().catch((e) => {
  console.error(deploymentError(e));
  process.exitCode = 1;
});
