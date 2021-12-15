import Web3 from "web3";
import { Log, LogsOptions, Transaction } from "web3-core";
import web3CoreSubscriptions, { Subscription } from "web3-core-subscriptions";
import { BlockHeader, Eth, Syncing } from "web3-eth";
import { decodeParameter } from "web3-eth-abi";
import { toHex } from "web3-utils";
import {
  AssetTransfersParams,
  AssetTransfersResponse,
  GetNftMetadataParams,
  GetNftMetadataResponse,
  GetNftsParams,
  GetNftsResponse,
  TokenAllowanceParams,
  TokenAllowanceResponse,
  TokenBalancesResponse,
  TokenMetadataResponse,
} from "./alchemy-apis/types";
import {
  AlchemyWeb3Config,
  FullConfig,
  Provider,
  TransactionsOptions,
  Web3Callback,
} from "./types";
import { formatBlock } from "./util/hex";
import { JsonRpcSenders } from "./util/jsonRpc";
import { callWhenDone } from "./util/promises";
import { makeAlchemyContext } from "./web3-adapter/alchemyContext";
import { patchEnableCustomRPC } from "./web3-adapter/customRPC";
import { patchEthFeeHistoryMethod } from "./web3-adapter/eth_feeHistory";
import { patchEthMaxPriorityFeePerGasMethod } from "./web3-adapter/eth_maxPriorityFeePerGas";
import { RestPayloadSender } from "./web3-adapter/sendRestPayload";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INTERVAL = 1000;
const DEFAULT_RETRY_JITTER = 250;

export interface AlchemyWeb3 extends Web3 {
  alchemy: AlchemyMethods;
  eth: AlchemyEth;
  setWriteProvider(provider: Provider | null | undefined): void;
}

export interface AlchemyMethods {
  getTokenAllowance(
    params: TokenAllowanceParams,
    callback?: Web3Callback<TokenAllowanceResponse>,
  ): Promise<TokenAllowanceResponse>;
  getTokenBalances(
    address: string,
    contractAddresses: string[],
    callback?: Web3Callback<TokenBalancesResponse>,
  ): Promise<TokenBalancesResponse>;
  getTokenMetadata(
    address: string,
    callback?: Web3Callback<TokenMetadataResponse>,
  ): Promise<TokenMetadataResponse>;
  getAssetTransfers(
    params: AssetTransfersParams,
    callback?: Web3Callback<AssetTransfersResponse>,
  ): Promise<AssetTransfersResponse>;
  getNftMetadata(
    params: GetNftMetadataParams,
    callback?: Web3Callback<GetNftMetadataResponse>,
  ): Promise<GetNftMetadataResponse>;
  getNfts(
    params: GetNftsParams,
    callback?: Web3Callback<GetNftsResponse>,
  ): Promise<GetNftsResponse>;
}

/**
 * Same as Eth, but with `subscribe` allowing more types.
 */
export interface AlchemyEth extends Eth {
  subscribe(
    type: "logs",
    options?: LogsOptions,
    callback?: (error: Error, log: Log) => void,
  ): Subscription<Log>;
  subscribe(
    type: "syncing",
    callback?: (error: Error, result: Syncing) => void,
  ): Subscription<Syncing>;
  subscribe(
    type: "newBlockHeaders",
    callback?: (error: Error, blockHeader: BlockHeader) => void,
  ): Subscription<BlockHeader>;
  subscribe(
    type: "pendingTransactions",
    callback?: (error: Error, transactionHash: string) => void,
  ): Subscription<string>;
  subscribe(
    type: "alchemy_fullPendingTransactions",
    callback?: (error: Error, transaction: Transaction) => void,
  ): Subscription<Transaction>;
  subscribe(
    type: "alchemy_filteredFullPendingTransactions",
    options?: TransactionsOptions,
    callback?: (error: Error, transaction: Transaction) => void,
  ): Subscription<Transaction>;
  subscribe(
    type:
      | "pendingTransactions"
      | "logs"
      | "syncing"
      | "newBlockHeaders"
      | "alchemy_fullPendingTransactions"
      | "alchemy_filteredFullPendingTransactions",
    options?: null | LogsOptions | TransactionsOptions,
    callback?: (
      error: Error,
      item: Log | Syncing | BlockHeader | string | Transaction,
    ) => void,
  ): Subscription<Log | BlockHeader | Syncing | string>;
}

interface EthereumWindow extends Window {
  ethereum?: any;
}

declare const window: EthereumWindow;

export function createAlchemyWeb3(
  alchemyUrl: string,
  config?: AlchemyWeb3Config,
): AlchemyWeb3 {
  const fullConfig = fillInConfigDefaults(config);
  const { provider, jsonRpcSenders, restSender, setWriteProvider } =
    makeAlchemyContext(alchemyUrl, fullConfig);
  const alchemyWeb3 = new Web3(provider) as AlchemyWeb3;
  alchemyWeb3.setProvider = () => {
    throw new Error(
      "setProvider is not supported in Alchemy Web3. To change the provider used for writes, use setWriteProvider() instead.",
    );
  };
  alchemyWeb3.setWriteProvider = setWriteProvider;
  alchemyWeb3.alchemy = {
    getTokenAllowance: (params: TokenAllowanceParams, callback) =>
      callAlchemyJsonRpcMethod({
        jsonRpcSenders,
        callback,
        method: "alchemy_getTokenAllowance",
        params: [params],
      }),
    getTokenBalances: (address, contractAddresses, callback) =>
      callAlchemyJsonRpcMethod({
        jsonRpcSenders,
        callback,
        method: "alchemy_getTokenBalances",
        params: [address, contractAddresses],
        processResponse: processTokenBalanceResponse,
      }),
    getTokenMetadata: (address, callback) =>
      callAlchemyJsonRpcMethod({
        jsonRpcSenders,
        callback,
        params: [address],
        method: "alchemy_getTokenMetadata",
      }),
    getAssetTransfers: (params: AssetTransfersParams, callback) =>
      callAlchemyJsonRpcMethod({
        jsonRpcSenders,
        callback,
        params: [
          {
            ...params,
            fromBlock:
              params.fromBlock != null
                ? formatBlock(params.fromBlock)
                : undefined,
            toBlock:
              params.toBlock != null ? formatBlock(params.toBlock) : undefined,
            maxCount:
              params.maxCount != null ? toHex(params.maxCount) : undefined,
          },
        ],
        method: "alchemy_getAssetTransfers",
      }),
    getNftMetadata: (params: GetNftMetadataParams, callback) =>
      callAlchemyRestEndpoint({
        restSender,
        callback,
        params,
        path: "/v1/getNFTMetadata/",
      }),
    getNfts: (params: GetNftsParams, callback) =>
      callAlchemyRestEndpoint({
        restSender,
        callback,
        params,
        path: "/v1/getNFTs/",
      }),
  };
  patchSubscriptions(alchemyWeb3);
  patchEnableCustomRPC(alchemyWeb3);
  patchEthFeeHistoryMethod(alchemyWeb3);
  patchEthMaxPriorityFeePerGasMethod(alchemyWeb3);
  return alchemyWeb3;
}

function fillInConfigDefaults({
  writeProvider = getWindowProvider(),
  maxRetries = DEFAULT_MAX_RETRIES,
  retryInterval = DEFAULT_RETRY_INTERVAL,
  retryJitter = DEFAULT_RETRY_JITTER,
}: AlchemyWeb3Config = {}): FullConfig {
  return { writeProvider, maxRetries, retryInterval, retryJitter };
}

function getWindowProvider(): Provider | null {
  return typeof window !== "undefined" ? window.ethereum : null;
}

interface CallAlchemyJsonRpcMethodParams<T> {
  jsonRpcSenders: JsonRpcSenders;
  method: string;
  params: any[];
  callback?: Web3Callback<T>;
  processResponse?(response: any): T;
}

interface CallAlchemyRestEndpoint<T> {
  restSender: RestPayloadSender;
  path: string;
  params: Record<string, any>;
  callback?: Web3Callback<T>;
  processResponse?(response: any): T;
}

function callAlchemyJsonRpcMethod<T>({
  jsonRpcSenders,
  method,
  params,
  callback = noop,
  processResponse = identity,
}: CallAlchemyJsonRpcMethodParams<T>): Promise<T> {
  const promise = (async () => {
    const result = await jsonRpcSenders.send(method, params);
    return processResponse(result);
  })();
  callWhenDone(promise, callback);
  return promise;
}

function callAlchemyRestEndpoint<T>({
  restSender,
  path,
  params,
  callback = noop,
  processResponse = identity,
}: CallAlchemyRestEndpoint<T>): Promise<T> {
  const promise = (async () => {
    const result = await restSender.sendRestPayload(path, params);
    return processResponse(result);
  })();
  callWhenDone(promise, callback);
  return promise;
}

function processTokenBalanceResponse(
  rawResponse: TokenBalancesResponse,
): TokenBalancesResponse {
  // Convert token balance fields from hex-string to decimal-string.
  const fixedTokenBalances = rawResponse.tokenBalances.map((balance) =>
    balance.tokenBalance != null
      ? {
          ...balance,
          tokenBalance: decodeParameter("uint256", balance.tokenBalance),
        }
      : balance,
  );
  return { ...rawResponse, tokenBalances: fixedTokenBalances };
}

/**
 * Updates Web3's internal subscription architecture to also handle Alchemy
 * specific subscriptions.
 */
function patchSubscriptions(web3: Web3): void {
  const { eth } = web3;
  const oldSubscribe = eth.subscribe.bind(eth);
  eth.subscribe = ((type: string, ...rest: any[]) => {
    if (
      type === "alchemy_fullPendingTransactions" ||
      type === "alchemy_newFullPendingTransactions"
    ) {
      return suppressNoSubscriptionExistsWarning(() =>
        oldSubscribe("alchemy_newFullPendingTransactions" as any, ...rest),
      );
    }
    if (
      type === "alchemy_filteredNewFullPendingTransactions" ||
      type === "alchemy_filteredPendingTransactions" ||
      type === "alchemy_filteredFullPendingTransactions"
    ) {
      return suppressNoSubscriptionExistsWarning(() =>
        oldSubscribe(
          "alchemy_filteredNewFullPendingTransactions" as any,
          ...rest,
        ),
      );
    }
    return oldSubscribe(type as any, ...rest);
  }) as any;
}

/**
 * VERY hacky wrapper to suppress a spurious warning when subscribing to an
 * Alchemy subscription that isn't built into Web3.
 */
function suppressNoSubscriptionExistsWarning<T>(f: () => T): T {
  const oldConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes(" doesn't exist. Subscribing anyway.")
    ) {
      return;
    }
    return oldConsoleWarn.apply(console, args);
  };
  try {
    return f();
  } finally {
    console.warn = oldConsoleWarn;
  }
}

/**
 * Another VERY hacky monkeypatch to make sure that we can take extra parameters to certain alchemy subscriptions
 * I hate doing this, but the other option is to fork web3-core and I think for now this is better
 */
const { subscription } = web3CoreSubscriptions as any;
const oldSubscriptionPrototypeValidateArgs =
  subscription.prototype._validateArgs;
subscription.prototype._validateArgs = function (args: any) {
  if (
    [
      "alchemy_filteredNewFullPendingTransactions",
      "alchemy_filteredPendingTransactions",
      "alchemy_filteredFullPendingTransactions",
    ].includes(this.subscriptionMethod)
  ) {
    // This particular subscription type is allowed to have additional parameters
  } else {
    if (
      [
        "alchemy_fullPendingTransactions",
        "alchemy_newFullPendingTransactions",
      ].includes(this.subscriptionMethod)
    ) {
      if (this.options.subscription) {
        this.options.subscription.subscriptionName = this.subscriptionMethod;
      }
    }

    const validator = oldSubscriptionPrototypeValidateArgs.bind(this);
    validator(args);
  }
};

function noop(): void {
  // Nothing.
}

function identity<T>(x: T): T {
  return x;
}
