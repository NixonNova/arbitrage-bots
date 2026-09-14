import { encode as msgpackEncode } from "@msgpack/msgpack";
import { computeAddress, keccak256, SigningKey, TypedDataEncoder } from "ethers";
import { optionalEnv, requiredEnv } from "../config/env";

/**
 * L1 action signing from the official Hyperliquid Python SDK
 * (sign_l1_action / action_hash), as pointed to by
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
 */

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

function normalizePrivateKey(raw: string): string {
  const key = raw.trim();
  return key.startsWith("0x") ? key : `0x${key}`;
}

export function getHyperliquidPrivateKey(): string {
  return normalizePrivateKey(requiredEnv("HYPERLIQUID_PRIVATE_KEY"));
}

export function deriveAddressFromPrivateKey(privateKey: string): string {
  return computeAddress(normalizePrivateKey(privateKey)).toLowerCase();
}

export function signingAddressFromKey(): string {
  return deriveAddressFromPrivateKey(getHyperliquidPrivateKey());
}

/** Master/vault address for queries + vaultAddress when signing with an API wallet. */
export function getHyperliquidAccountAddress(): string {
  const configured = optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS")?.toLowerCase();
  if (configured) {
    return configured;
  }
  return signingAddressFromKey();
}

function addressToBytes(address: string): Uint8Array {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function u64Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function actionHash(
  action: object,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null,
): string {
  const packed = msgpackEncode(action);
  let data = concatBytes(packed, u64Bytes(nonce));
  if (vaultAddress) {
    data = concatBytes(data, Uint8Array.of(1), addressToBytes(vaultAddress));
  } else {
    data = concatBytes(data, Uint8Array.of(0));
  }
  if (expiresAfter !== null) {
    data = concatBytes(data, Uint8Array.of(0), u64Bytes(expiresAfter));
  }
  return keccak256(data);
}

export function signL1Action(
  action: object,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null = null,
  isMainnet = true,
): HyperliquidSignature {
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter);
  const domain = {
    name: "Exchange",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };
  const message = {
    source: isMainnet ? "a" : "b",
    connectionId: hash,
  };
  const digest = TypedDataEncoder.hash(domain, types, message);
  const signed = new SigningKey(getHyperliquidPrivateKey()).sign(digest);
  return {
    r: signed.r,
    s: signed.s,
    v: signed.v,
  };
}

export function vaultAddressForRequest(): string | null {
  const account = getHyperliquidAccountAddress();
  const signer = signingAddressFromKey();
  return account !== signer ? account : null;
}
