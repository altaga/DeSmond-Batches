import {
  AgentKit,
  ERC20ActionProvider
} from "@coinbase/agentkit";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { tool } from "@langchain/core/tools";
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from "@langchain/ollama";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import {
  ContentTypeWalletSendCalls,
  WalletSendCallsCodec,
} from "@xmtp/content-type-wallet-send-calls";
import { Client, Dm, Group, IdentifierKind } from "@xmtp/node-sdk";
import {
  Contract,
  EnsResolver,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "ethers";
import { DynamicProvider, FallbackStrategy } from "ethers-dynamic-provider";
import { v4 as uuidv4 } from "uuid";
import { encodePacked, keccak256, namehash, toBytes, toHex } from "viem";
import { base, mainnet } from "viem/chains";
import { z } from "zod";
import { basenamesABI } from "./contracts/basenames.js";
import { abiERC20 } from "./contracts/erc20.js";

///////////////////////////////////////// Program Tools ////////////////////////////////////////

const convertChainIdToCoinType = (chainId) => {
  // L1 resolvers to addr
  if (chainId === mainnet.id) {
    return "addr";
  }
  const cointype = (0x80000000 | chainId) >>> 0;
  return cointype.toString(16).toLocaleUpperCase();
};

const convertReverseNodeToBytes = (address, chainId) => {
  const addressFormatted = address.toLocaleLowerCase();
  const addressNode = keccak256(addressFormatted.substring(2));
  const chainCoinType = convertChainIdToCoinType(chainId);
  const baseReverseNode = namehash(
    `${chainCoinType.toLocaleUpperCase()}.reverse`
  );
  const addressReverseNode = keccak256(
    encodePacked(["bytes32", "bytes32"], [baseReverseNode, addressNode])
  );
  return addressReverseNode;
};

function setupProvider(rpcs) {
  return new DynamicProvider(rpcs, {
    strategy: new FallbackStrategy(),
  });
}

function epsilonRound(value, decimals = 6) {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const rpcs = [
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
];

const ethRpcs = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://eth-pokt.nodies.app",
  "https://eth.drpc.org",
];

const usdc = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};

const provider = setupProvider(rpcs);
const ethProvider = setupProvider(ethRpcs);
const contract = new Contract(usdc.address, abiERC20, provider);
const contractBaseNames = new Contract(
  "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD",
  basenamesABI,
  provider
);

async function getBasename(address) {
  try {
    const addressReverseNode = convertReverseNodeToBytes(address, base.id);
    const name = await contractBaseNames.name(addressReverseNode);
    return name === "" ? address : name;
  } catch (e) {
    return address;
  }
}

async function getAddress(basename) {
  try {
    const ensResolver = await EnsResolver.fromName(ethProvider, basename);
    if (!ensResolver) {
      return "";
    } else {
      const address = await ensResolver.getAddress();
      return address;
    }
  } catch (e) {
    return "";
  }
}

///////////////////////////////////////// Agent Kit ////////////////////////////////////////

const agentKit = await AgentKit.from({
  cdpApiKeyId: process.env.CDP_API_KEY_ID,
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  actionProviders: [new ERC20ActionProvider()],
});

///////////////////////////////////////// Agent Setup ////////////////////////////////////////

const config = (data = {}) => {
  return { configurable: { thread_id: uuidv4(), ...data } };
};

// Classes
const webSearchTool = new DuckDuckGoSearch({
  safeSearch: "strict",
  maxResults: 10,
});

// Model
const llm = new ChatOllama({ // Custom Ollama Model
  model: "llama3.1:8b",
  temperature: 0.1,
  maxRetries: 2,
  keepAlive: "24h",
  numCtx: 1024 * 25,
});

// Create Transaction
const createTransaction = async (amount, to, from) => {
  const flag = to.indexOf(".base.eth") > -1;
  const addressTo = flag ? await getAddress(to) : to;
  if (addressTo === "") {
    return {
      version: "",
    };
  } else {
    const baseNameFrom = await getBasename(from);
    return {
      version: "1.0",
      from,
      chainId: toHex(8453),
      calls: [
        {
          to: addressTo,
          value: Number(parseEther(amount)),
          metadata: {
            description: `Transfer ${amount} ETH on Base Mainnet to ${
              !flag ? addressTo : to
            }. Signing required from ${baseNameFrom}.`,
            transactionType: "transfer",
            currency: "ETH",
            amount,
            decimals: 18,
            networkId: "base-mainnet",
          },
        },
        /* add more calls here */
      ],
    };
  }
};

// Create Transaction USDC
const createTransactionUSDC = async (amount, to, from) => {
  const flag = to.indexOf(".base.eth") > -1;
  const addressTo = flag ? await getAddress(to) : to;
  if (addressTo === "") {
    return {
      version: "",
    };
  } else {
    const baseNameFrom = await getBasename(from);
    const data = contract.interface.encodeFunctionData("transfer", [
      addressTo,
      parseUnits(amount, usdc.decimals),
    ]);
    return {
      version: "1.0",
      from,
      chainId: toHex(8453),
      calls: [
        {
          to: usdc.address,
          data,
          metadata: {
            description: `Transfer ${amount} USDC on Base Mainnet to ${
              !flag ? addressTo : to
            }. Signing required from ${baseNameFrom}.`,
            transactionType: "transfer",
            currency: "USDC",
            amount,
            decimals: 6,
            networkId: "base-mainnet",
          },
        },
        /* add more calls here */
      ],
    };
  }
};

// Transfer Native
const transferNative = tool(
  async (
    { amount, toAddress },
    { configurable: { fromAddress, conversation } }
  ) => {
    const transaction = await createTransaction(amount, toAddress, fromAddress);
    if (transaction.version === "1.0") {
      await conversation.send(transaction, ContentTypeWalletSendCalls);
    }
    return `I have sent the transaction. Please review and sign it when you're ready.`;
  },
  {
    name: "transfer_native",
    description:
      "This tool facilitates native Ethereum (ETH) transfers on the Base mainnet. It activates whenever the user explicitly requests to send ETH, initiates a transaction, or mentions terms like 'transfer,' 'ETH,' or 'Base mainnet' in relation to their wallet activity.",
    schema: z.object({
      amount: z.string(),
      toAddress: z.string(),
    }),
  }
);

// Transfer USDC

const transferUSDC = tool(
  async (
    { amount, toAddress },
    { configurable: { fromAddress, conversation } }
  ) => {
    const transaction = await createTransactionUSDC(
      amount,
      toAddress,
      fromAddress
    );
    if (transaction.version === "1.0") {
      await conversation.send(transaction, ContentTypeWalletSendCalls);
    }
    return `I have sent the transaction. Please review and sign it when you're ready.`;
  },
  {
    name: "transfer_usdc",
    description:
      "This tool facilitates USD Coin (USDC) transfers on the Base mainnet. It activates whenever the user explicitly requests to send USDC, initiates a transaction, or mentions terms like 'transfer,' 'USDC,' or 'Base mainnet' in relation to their wallet activity.",
    schema: z.object({
      amount: z.string(),
      toAddress: z.string(),
    }),
  }
);

// Split payment
const splitPayment = tool(
  async (
    { amount, toAddress },
    { configurable: { members, conversation } }
  ) => {
    const amount_ = epsilonRound(parseFloat(amount) / members.length);
    const transactions = await Promise.all(
      members.map((address) =>
        createTransactionUSDC(amount_.toString(), toAddress, address)
      )
    );
    for (const transaction of transactions) {
      if (transaction.version === "1.0") {
        await conversation.send(transaction, ContentTypeWalletSendCalls);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return `I've sent a transaction to each of the ${members.length} recipients. Each one needs to review and sign their transaction.`;
  },
  {
    name: "split_payment",
    description:
      "This tool facilitates splitting a USDC payment among all group members, ensuring that each user signs their transaction correctly. It activates whenever users explicitly request to split a payment, distribute funds among group members, or mention terms like 'split payment,' 'USDC,' or 'group transaction' in relation to their financial activities.",
    schema: z.object({
      amount: z.string(),
      toAddress: z.string(),
    }),
  }
);

// Get Native Balance
const getBalance = tool(
  async (_, { configurable: { fromAddress } }) => {
    const balance = await provider.getBalance(fromAddress);
    const balanceInEth = parseFloat(formatEther(balance)).toFixed(6);
    return `The user's ETH (Base Mainnet) balance is ${balanceInEth} ETH. Don't round or modify the balance.`;
  },
  {
    name: "get_balance",
    description:
      "This tool allows users to retrieve accurate and up-to-date Ethereum (ETH) balance information on the Base mainnet. It activates whenever the user explicitly requests their ETH balance, checks wallet holdings, or mentions terms like 'balance,' 'ETH,' or 'Base mainnet' in relation to their account status.",
    schema: z.object({}),
  }
);

// Get Group Balance

const getBalanceGroup = tool(
  async (_, { configurable: { members } }) => {
    const balances = await Promise.all(
      members.map((address) => provider.getBalance(address))
    );
    const members_ = await Promise.all(
      members.map((address) => getBasename(address))
    );
    console.log(members_);
    const balancesInEth = balances.map((balance) =>
      parseFloat(formatEther(balance)).toFixed(6)
    );
    const response = `
        The ETH (Base Mainnet) balance of the addresses in this chat are:

        ${balancesInEth
          .map(
            (balance, index) =>
              `- ${members_[index]} => ${balance} ETH (Base Mainnet)`
          )
          .join("\n")}

        Return this list exactly as it is. Do not include any statements such as 'Please note that these balances are subject to change and may not reflect the current balance.' Return this list exactly as it is. The values on this list are entirely real and up-to-date. Return this list exactly as it is.
    `;
    console.log(response);
    return response;
  },
  {
    name: "get_balances",
    description:
      "This tool allows users to retrieve accurate and up-to-date Ethereum (ETH) balances information on the Base mainnet. It activates whenever the user explicitly requests the group ETH balances, checks wallet holdings, or mentions terms like 'balances,' 'ETH,' or 'Base mainnet' in relation to their accounts on the group status.",
    schema: z.object({}),
  }
);

// Get Native Balance
const getBalanceUSDC = tool(
  async (_, { configurable: { fromAddress } }) => {
    const balance = await contract.balanceOf(fromAddress);
    const balanceInUSDC = parseFloat(
      formatUnits(balance, usdc.decimals)
    ).toFixed(6);
    return `The user's USDC (Base Mainnet) balance is ${balanceInUSDC} USDC. Don't round or modify the balance.`;
  },
  {
    name: "get_balance_usdc",
    description:
      "This tool allows users to retrieve accurate and up-to-date USD Coin (USDC) balance information on the Base mainnet. It activates whenever the user explicitly requests their USDC balance, checks wallet holdings, or mentions terms like 'balance,' 'USDC,' or 'Base mainnet' in relation to their account status.",
    schema: z.object({}),
  }
);

// Get Group Balance USDC

const getBalanceUSDCGroup = tool(
  async (_, { configurable: { members } }) => {
    const balances = await Promise.all(
      members.map((address) => contract.balanceOf(address))
    );
    const members_ = await Promise.all(
      members.map((address) => getBasename(address))
    );
    const balancesInUSDC = balances.map((balance) =>
      parseFloat(formatUnits(balance, usdc.decimals)).toFixed(6)
    );
    const response = `
        The USDC (Base Mainnet) balance of the addresses in this chat are:

        ${balancesInUSDC
          .map(
            (balance, index) =>
              `- ${members_[index]} => ${balance} USDC (Base Mainnet)`
          )
          .join("\n")}

        Return this list exactly as it is. Do not include any statements such as 'Please note that these balances are subject to change and may not reflect the current balance.' Return this list exactly as it is. The values on this list are entirely real and up-to-date. Return this list exactly as it is.
    `;
    console.log(response);
    return response;
  },
  {
    name: "get_balances_usdc",
    description:
      "This tool allows users to retrieve accurate and up-to-date USD Coin (USDC) balance information on the Base mainnet. It activates whenever the user explicitly requests the group USDC balances, checks wallet holdings, or mentions terms like 'balances,' 'USDC,' or 'Base mainnet' in relation to their accounts on the group status.",
    schema: z.object({}),
  }
);

// Web Search Tool
const webSearch = tool(
  ({ query }) => {
    console.log("Web Search Tool");
    let res = webSearchTool.invoke(query);
    return res;
  },
  {
    name: "web_search",
    description:
      "This tool allows users to perform accurate and targeted internet searches for specific terms or phrases. It activates whenever the user explicitly requests a web search, seeks real-time or updated information, or mentions terms like 'search,' 'latest,' or 'current' related to the desired topic.",
    schema: z.object({
      query: z.string(),
    }),
  }
);

// Fallback Tool
const fallbackTool = tool(
  () => {
    console.log("Fallback Tool");
    return "As stated above, say something friendly and invite the user to interact with you.";
  },
  {
    name: "fallback",
    description:
      "This tool activates only when the assistant has no other tool actively invoked in response to a user query",
    schema: z.object({}),
  }
);

// Utils
function setInput(input) {
  return {
    messages: [
      {
        role: "system",
        content:
          "Act as DeSmond, a highly knowledgeable, perceptive, and approachable assistant. Never return lines of code like pyhton or nodejs. DeSmond is capable of providing accurate insights, answering complex inquiries, and offering thoughtful guidance in various domains. Never return lines of code like pyhton or nodejs. Embody professionalism and warmth, tailoring responses to meet the user's needs effectively while maintaining an engaging and helpful tone. Never return lines of code like pyhton or nodejs.",
      },
      {
        role: "user",
        content: input,
      },
    ],
  };
}

// Workflow Tools
const my_tools_dm = [
  webSearch,
  fallbackTool,
  getBalance,
  getBalanceUSDC,
  transferNative,
  transferUSDC,
];
const tools_node_dm = new ToolNode(my_tools_dm);
const llm_with_tools_dm = llm.bindTools(my_tools_dm);

const my_tools_group = [
  webSearch,
  fallbackTool,
  getBalance,
  getBalanceGroup,
  getBalanceUSDC,
  getBalanceUSDCGroup,
  transferNative,
  transferUSDC,
  splitPayment,
];
const tools_node_group = new ToolNode(my_tools_group);
const llm_with_tools_group = llm.bindTools(my_tools_group);

// Workflow Utils
const call_model_dm = async (state) => {
  console.log("Model Node");
  const response = await llm_with_tools_dm.invoke(state.messages);
  return { messages: response };
};

const call_model_group = async (state) => {
  console.log("Model Node");
  const response = await llm_with_tools_group.invoke(state.messages);
  return { messages: response };
};

function shouldContinue(state) {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];
  console.log(lastMessage["tool_calls"]);
  if (lastMessage["tool_calls"].length > 0) {
    if (
      ["transfer_native", "transfer_usdc", "split_payment"].includes(
        lastMessage["tool_calls"][0]["name"]
      )
    ) {
      return "bypass";
    }
    return "tool";
  } else {
    return END;
  }
}

// Workflow

const workflow_dm = new StateGraph(MessagesAnnotation)
  // Define the node and edge
  .addNode("model", call_model_dm)
  .addNode("tool", tools_node_dm)
  .addNode("bypass", tools_node_dm)
  .addConditionalEdges("model", shouldContinue, ["tool", "bypass", END])
  .addEdge(START, "model")
  .addEdge("bypass", END)
  .addEdge("tool", "model"); // Process the tool call with the model

const workflow_group = new StateGraph(MessagesAnnotation)
  // Define the node and edge
  .addNode("model", call_model_group)
  .addNode("tool", tools_node_group)
  .addNode("bypass", tools_node_group)
  .addConditionalEdges("model", shouldContinue, ["tool", "bypass", END])
  .addEdge(START, "model")
  .addEdge("bypass", END)
  .addEdge("tool", "model"); // Process the tool call with the model

const memory = new MemorySaver();

// Graph Compilation
const graph_dm = workflow_dm.compile({ checkpointer: memory });
const graph_group = workflow_group.compile({ checkpointer: memory });

///////////////////////////////////////// XMTP Setup ////////////////////////////////////////

// XMTP Client Setup

async function main() {
  const input = setInput("Hello Desmond");
  await graph_dm.invoke(input, config());
  setInterval(async () => {
    await graph_dm.invoke(input, config());
  }, 1000 * 60 * 60 * 23); // Run every 23 hours to prevent ollama server sleeps

  const client = await Client.create(signer, {
    dbPath: null,
    env: "production",
    codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
  });

  console.log("✓ Syncing conversations...");

  while (true) {
    try {
      await client.conversations.sync();
      const stream = await client.conversations.streamAllMessages();
      for await (const message of stream) {
        try {
          // Filter 1: Ignore messages from self
          if (
            message?.senderInboxId.toLowerCase() ===
              client.inboxId.toLowerCase() ||
            message?.contentType?.typeId !== "text"
          ) {
            continue;
          }
          // Filter 2: Check if the message is a group message or DM
          const conversation = await client.conversations.getConversationById(
            message.conversationId
          );

          // Filter 3: Check if the conversation exists
          if (!conversation) {
            console.log("Unable to find conversation, skipping");
            continue;
          }
          // Select Agent context for conversation

          if (conversation instanceof Group) {
            if (!message.content.toLowerCase().includes("@desmond")) continue;
            onMessageGroup(conversation, message);
          } else if (conversation instanceof Dm) {
            onMessageDM(conversation, message);
          }
        } catch (e) {
          console.log(e);
        }
      }
    } catch (e) {
      console.log(e);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function getSignature(user, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      command: "createSignature",
      user,
      message,
    });
    fetch("https://custom-wallets.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    })
      .then((response) => response.json())
      .then((data) => {
        resolve(data.result);
      });
  });
}

const signer = {
  type: "SCW",
  getIdentifier: () => ({
    identifierKind: IdentifierKind.Ethereum,
    identifier: "0xc69449f60de274ca80b6d115019436788df274df",
  }),
  signMessage: async (message) => {
    // Custom Wallet Signature
    const signature = await getSignature("xxxxxxx", message);
    return toBytes(signature);
  },
  getChainId: () => {
    return 8453n;
  },
};

///////////////////////////////////////// Agent Inbox ////////////////////////////////////////

const onMessageDM = async (conversation, event) => {
  await conversation.send("Processing...");
  console.log({ event, kind: "DM" });
  const agentAddress = signer.getIdentifier().identifier.toLowerCase();
  let members = await conversation.members();
  const fromAddress = members.filter(
    (m) => m.inboxId === event.senderInboxId
  )[0].accountIdentifiers[0].identifier;
  const context = { origin: "DM", agentAddress, fromAddress, conversation };
  const input = setInput(event.content);
  const output = await graph_dm.invoke(input, config(context));
  conversation.send(output.messages[output.messages.length - 1].content);
};

const onMessageGroup = async (conversation, event) => {
  await conversation.send("Processing...");
  console.log({ event, kind: "Group" });
  const agentAddress = signer.getIdentifier().identifier.toLowerCase();
  let members = await conversation.members();
  const fromAddress = members.filter(
    (m) => m.inboxId === event.senderInboxId
  )[0].accountIdentifiers[0].identifier;
  members = members.filter(
    (m) => m.accountIdentifiers[0].identifier !== agentAddress
  );
  members = members.map((m) => m.accountIdentifiers[0].identifier);
  const context = {
    origin: "Group",
    members,
    agentAddress,
    fromAddress,
    conversation,
  };
  const input = setInput(event.content.replace("@DeSmond", ""));
  const output = await graph_group.invoke(input, config(context));
  conversation.send(output.messages[output.messages.length - 1].content);
};

main();
