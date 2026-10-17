// SPDX-License-Identifier: MPL-2.0
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { ClientIdentitySchema, DeviceDescriptorSchema, EndpointSchema } from "./schemas.ts";
import { BridgeError, PROTOCOL_VERSION, type Capability, type DeviceDescriptor } from "./protocol.ts";

const runFile = promisify(execFile);
export interface Endpoint { readonly url: string; readonly token: string; readonly pid?: number }
export interface ClientIdentity { readonly device: DeviceDescriptor; readonly publicKey: string; readonly privateKey: string }

export function defaultStateDir(): string {
	if (process.env.TERN_OMP_BRIDGE_HOME) return path.resolve(process.env.TERN_OMP_BRIDGE_HOME);
	if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "tern-omp-client-bridge");
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "tern-omp-client-bridge");
	return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "tern-omp-client-bridge");
}

export const MINIMUM_BUN_VERSION = "1.4.3";

export function assertSupportedRuntime(): void {
	if (!Bun.semver.satisfies(Bun.version, `>=${MINIMUM_BUN_VERSION}`)) throw new BridgeError("UNSUPPORTED_RUNTIME", `Bridge services require Bun ${MINIMUM_BUN_VERSION} or newer; Bun 1.3.14 can hang while closing WebSocket servers. The native OMP host is not replaced.`);
}

export async function protectPrivatePath(file: string, directory = false): Promise<void> {
	if (process.platform !== "win32") {
		await chmod(file, directory ? 0o700 : 0o600);
		return;
	}
	const encodedPath = Buffer.from(file, "utf8").toString("base64");
	const script = `
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$inheritance = [Security.AccessControl.InheritanceFlags]::${directory ? "ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit" : "None"}
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
`;
	await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await protectPrivatePath(directory, true);
	const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	try { await protectPrivatePath(temporary); await rename(temporary, file); }
	finally { await rm(temporary, { force: true }); }
}

export async function readEndpoint(file: string): Promise<Endpoint> {
	let input: Endpoint;
	try { input = EndpointSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
	catch { throw new BridgeError("BRIDGE_UNAVAILABLE", `Bridge connection metadata is unavailable: ${file}`); }
	const url = new URL(input.url);
	if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new BridgeError("INVALID_ENDPOINT", "Bridge control endpoints must be bare loopback HTTP origins");
	return { ...input, url: url.origin };
}

export function authorized(request: Request, token: string): boolean {
	if (request.headers.has("origin")) return false;
	const supplied = request.headers.get("authorization");
	const expected = `Bearer ${token}`;
	if (supplied === null || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)) return false;
	return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function publicKeyId(publicKey: string): string {
	const key = createPublicKey(publicKey);
	if (key.asymmetricKeyType !== "ed25519") throw new BridgeError("INVALID_IDENTITY", "Client identities must use Ed25519");
	return "client_" + createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);
}

function identityPayload(challenge: string, device: DeviceDescriptor): Buffer {
	return Buffer.from(JSON.stringify([PROTOCOL_VERSION, challenge, device.id, device.name, device.platform, device.arch, [...device.capabilities].sort()]));
}

export function signIdentity(challenge: string, identity: ClientIdentity): string {
	return sign(null, identityPayload(challenge, identity.device), createPrivateKey(identity.privateKey)).toString("base64");
}

export function verifyIdentity(challenge: string, device: DeviceDescriptor, publicKey: string, signature: string): boolean {
	try { return device.id === publicKeyId(publicKey) && verify(null, identityPayload(challenge, device), createPublicKey(publicKey), Buffer.from(signature, "base64")); }
	catch { return false; }
}

export async function loadClientIdentity(stateDir: string, options: { name?: string; capabilities?: readonly Capability[] } = {}): Promise<ClientIdentity> {
	const file = path.join(stateDir, "identity.json");
	let identity: ClientIdentity;
	try {
		identity = ClientIdentitySchema.parse(JSON.parse(await readFile(file, "utf8")));
		if (publicKeyId(identity.publicKey) !== identity.device.id) throw new BridgeError("INVALID_IDENTITY", "Client identity file is inconsistent");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		if (!options.capabilities) throw new BridgeError("AUTHORIZATION_REQUIRED", "Choose client capabilities explicitly with --allow before enabling this device");
		const pair = generateKeyPairSync("ed25519");
		const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
		const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		identity = { device: DeviceDescriptorSchema.parse({ id: publicKeyId(publicKey), name: options.name ?? os.hostname(), platform: process.platform, arch: process.arch, capabilities: [...options.capabilities] }), publicKey, privateKey };
	}
	const device = DeviceDescriptorSchema.parse({ ...identity.device, name: options.name ?? identity.device.name, capabilities: options.capabilities ?? identity.device.capabilities });
	identity = { ...identity, device };
	if (!verifyIdentity("identity-file-check", device, identity.publicKey, signIdentity("identity-file-check", identity))) throw new BridgeError("INVALID_IDENTITY", "Client private and public keys do not match");
	await writePrivateJson(file, identity);
	return identity;
}
