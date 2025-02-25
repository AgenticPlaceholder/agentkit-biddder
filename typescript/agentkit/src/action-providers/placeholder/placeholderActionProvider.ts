/* eslint-disable jsdoc/require-hyphen-before-param-description */
/* eslint-disable jsdoc/tag-lines */
/* eslint-disable jsdoc/valid-types */
/* eslint-disable jsdoc/require-jsdoc */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable multiline-comment-style */
import { z } from "zod";
import { ActionProvider } from "../actionProvider";
import { Network } from "../../network";
import { CreateAction } from "../actionDecorator";
import { PlaceBidSchema, SelectPriceSchema, SelectStrategySchema } from "./schemas";
import { abi } from "./constants";
import { encodeFunctionData, formatUnits, Hex, parseUnits } from "viem";
import { EvmWalletProvider } from "../../wallet-providers";
import { ethers, JsonRpcProvider, WebSocketProvider } from "ethers";
import { BiddingStrategy, AuctionState } from "./types";
import { strategies } from "./strategies";

export interface PlaceholderActionProviderInterface {
  startMonitoring(walletProvider: EvmWalletProvider): Promise<void>;
}
/**
 * PlaceholderActionProvider is an action provider for the Placeholder Ads auction contract.
 */
export class PlaceholderActionProvider
  extends ActionProvider<EvmWalletProvider>
  implements PlaceholderActionProviderInterface
{
  private readonly contractAddress: string;
  private currentStrategy: BiddingStrategy;
  private auctionState!: AuctionState;

  private wssProvider? = process.env.WS_RPC_URL
    ? new WebSocketProvider(process.env.WS_RPC_URL)
    : undefined;
  private httpProvider? = new JsonRpcProvider(process.env.HTTP_RPC_URL);
  private activeWalletProvider?: EvmWalletProvider;
  private lastSuggestedPrice: string | null = null;

  /**
   * Constructor for the PlaceholderActionProvider.
   */
  constructor() {
    super("placeholder", []);
    if (!process.env.PLACEHOLDER_CONTRACT_ADDRESS) {
      throw new Error("PLACEHOLDER_CONTRACT_ADDRESS not set in environment");
    }
    this.contractAddress = process.env.PLACEHOLDER_CONTRACT_ADDRESS;
    //assing at random strategy
    const strategyNames = Object.keys(strategies);
    this.currentStrategy =
      strategies[strategyNames[Math.floor(Math.random() * strategyNames.length)]];
    // this.auctionState.maxDisplays = 5;
  }
  @CreateAction({
    name: "select_strategy",
    description: `
    Select a bidding strategy based on current market conditions and past performance.
    Available strategies:
        - Remember This is a Dutch Auction.
        - Price starts high and decreases linear.
        - First to bid always wins.
        - aggressive: Bids at current price immediately
        - patient: Waits for price to drop 50% from start to end price
        - conservative: Waits for price to drop 80% from start to end price
    `,
    schema: SelectStrategySchema,
  })
  async selectStrategy(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof SelectStrategySchema>,
  ): Promise<string> {
    this.currentStrategy = strategies[args.strategy];
    return `Strategy updated to ${args.strategy}. Reason: ${args.reason}`;
  }

  @CreateAction({
    name: "select_price",
    description: `
    Determine the optimal bid price based on the current strategy and market conditions.
    Returns a suggested bid price and explanation.
    The price should follow the current strategy's guidelines.
    `,
    schema: SelectPriceSchema,
  })
  async selectPrice(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof SelectPriceSchema>,
  ): Promise<string> {
    this.lastSuggestedPrice = args.suggestedPrice;
    return `Selected bid price of ${args.suggestedPrice} USD.\nReason: ${args.reason}`;
  }
  @CreateAction({
    name: "auction_details",
    description: `
  This tool will Return the current state of the Placeholder Ads auction.
  
  It returns the following details:
  - isActive: Whether the auction is active or not
  - startPrice: The starting price of the auction
  - endPrice: The ending price of the auction
  - currentDisplay: The current display number
  - maxDisplays: The maximum display number
  - needsStrategyUpdate: Wheather the strategy needs to be updated or not
  - lastStrategySuccess: Whether the last bid was successful or not
  - currentPrice: The current price of the auction
  
  It takes no inputs.
  `,
    schema: z.object({}),
  })
  /**
   * Returns the current state of the Placeholder Ads auction.
   // eslint-disable-next-line jsdoc/require-hyphen-before-param-description, jsdoc/require-hyphen-before-param-description
   * @param - No inputs
   * @returns A string containing the auction state, with the following format:
   * "isActive:" boolean
   * "currentDisplay:" number
   * "maxDisplays:" number
   * "startPrice:" bigint
   * "endPrice:" bigint
   * "startTime:" bigint
   * "duration in seconds:" bigint
   * "lastSuccessfulBid:" number
   * "lastFailedBid:" number
   */
  // eslint-disable-next-line jsdoc/require-jsdoc
  async getAuctionDetails(): Promise<string> {
    const response: string = `Auction Details
    "isActive:" ${this.auctionState.isActive}
    "startPrice:" ${this.auctionState.startPrice}
    "endPrice:" ${this.auctionState.endPrice}
    "currentDisplay:" ${this.auctionState.currentDisplay}
    "maxDisplays:" ${this.auctionState.maxDisplays}
    "lastSuccessfulBid:" ${this.auctionState.lastAuctionResult?.wasWinner}
    "needsStrategyUpdate:" ${this.auctionState.needsStrategyUpdate}
    "currentPrice:" ${this.auctionState.currentPrice}
    `;
    return response;
  }
  /**
   * Places a bid in the auction for a specific token.
   *
   * @param walletProvider - The wallet provider to place the bid from.
   * @param args - The bid parameters including tokenId and bidAmount.
   * @returns A message containing the bid transaction details.
   */
  @CreateAction({
    name: "place_bid",
    description: `
    This tool will place a bid in the Placeholder Ads auction for a specific price inUSD.
    
    It takes the following inputs:
    - tokenId: The ID of the token to bid on
    - bidAmount: The amount to bid in USD  values.
    
    The bid amount should be in USD  values.
    Example: To bid 100 USD, use "100".
    `,
    schema: PlaceBidSchema,
  })
  async placeBid(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PlaceBidSchema>,
  ): Promise<string> {
    try {
      const isActive = await this.getAuctionState();
      if (!isActive) {
        console.log("Auction is not active");
        return "Auction is not active yet.";
      }
      const parsedAmount = parseUnits(args.bidAmount, 18);

      console.log("Placing bid for token", args.tokenId, "with USD amount", args.bidAmount);
      const txData = encodeFunctionData({
        abi,
        functionName: "placeBid",
        args: [BigInt(args.tokenId), parsedAmount],
      });

      const hash = await walletProvider.sendTransaction({
        to: this.contractAddress as Hex,
        data: txData as Hex,
        value: 0n,
      });

      const receipt = await walletProvider.waitForTransactionReceipt(hash);
      if (receipt.status === "success") {
        console.log("Transaction executed successfully.");
        console.log(
          `Auction won for token ${args.bidAmount}.\nTransaction hash: https://sepolia.basescan.org/tx/${hash}`,
        );

        return `Auction won for token id ${args.tokenId} with ${args.bidAmount} USD.
        
        `;
      } else {
        console.log("Transaction failed or reverted.");
        return `Error placing bid: ${Error}`;
      }
      // sleep for 5 seconds
    } catch (error) {
      return `Error placing bid: ${error}`;
    }
  }
  supportsNetwork = (_: Network) => true;

  /**
   * Returns the current price of the auction.
   *
   * @returns The current price of the auction in wei.
   */
  public async fetchCurrentPrice(): Promise<bigint> {
    const currentPrice = await this.getCurrentPrice();
    return currentPrice;
  }
  /**
   * Initializes the provider and starts monitoring events.
   *
   * @param walletProvider - The wallet provider to use for transactions
   */
  public async startMonitoring(walletProvider: EvmWalletProvider): Promise<void> {
    if (!process.env.WS_RPC_URL) {
      throw new Error("WS_RPC_URL environment variable is not set");
    }

    this.activeWalletProvider = walletProvider;

    const contract = new ethers.Contract(this.contractAddress, abi, this.wssProvider);

    await this.setupEventListeners(contract);
    console.log("Started monitoring auction events");
  }
  /**
   * Sets up event listeners for the auction contract.
   *
   * @param contract - The ethers Contract instance
   */
  private async setupEventListeners(contract: ethers.Contract) {
    try {
      console.log("Setting up event listeners...");

      contract.on(
        "AuctionStarted",
        async (
          startPrice: bigint,
          endPrice: bigint,
          startTime: bigint,
          duration: bigint,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
          event: any,
        ) => {
          console.log("-----------------------------\n");
          console.log("Auction Started Event Received");
          console.log(`  Start Price: ${ethers.formatUnits(startPrice, 18)}`);
          console.log(`  End Price:   ${ethers.formatUnits(endPrice, 18)}`);
          console.log(`  Start Time:  ${new Date(Number(startTime) * 1000).toLocaleString()}`);
          console.log(`  Duration:    ${Number(duration)} seconds`);
          console.log("-----------------------------\n\n");

          this.auctionState = {
            ...this.auctionState,
            isActive: true,
            startPrice,
            endPrice,
            startTime,
            duration,
            needsStrategyUpdate: true, // Signal that we should evaluate strategy
            lastStrategySuccess: this.auctionState.lastStrategySuccess, // Preserve previous result
            marketConditions: {
              priceRange: startPrice - endPrice,
              timeRemaining: duration,
              priceDropRate: (startPrice - endPrice) / duration,
            },
          };
          await this.getAuctionDetails();
          // await this.executeStrategy();
        },
      );
      // AuctionStarted event
      contract.on(
        "AuctionEnded",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
        async (winner: string, winningBid: bigint, tokenId: bigint, event: any) => {
          console.log("------------🔚-----------------");
          console.log("Auction Ended Event Received");
          console.log(`  Winner:       ${winner}`);
          console.log(`  Winning Bid:  ${ethers.formatUnits(winningBid, 18)}`);
          console.log(`  Token ID:     ${tokenId.toString()}`);
          console.log("-----------------------------");
          this.auctionState.isActive = false;
          if (winner === "0xbb02a9D6A71A847D587cE4Dbb92F32f79c2EfB2a") {
            this.auctionState.currentDisplay++;
            console.log("Auction won!");
            this.auctionState = {
              ...this.auctionState,
              isActive: false,
              lastAuctionResult: {
                winner,
                winningBid,
                wasWinner: true,
                tokenId,
              },
            };
            if (this.auctionState.lastAuctionResult?.wasWinner === true) {
              console.log("🎉 Auction won!");

              await this.getAuctionDetails();
              await this.evaluateAndUpdateStrategy(true);
            }

            await this.getAuctionDetails();

            this.evaluateAndUpdateStrategy(true);
          } else {
            console.log("❌ Auction lost!");
            await this.evaluateAndUpdateStrategy(false);
          }
        },
      );
      // AuctionEnded event

      console.log("Event listeners setup completed");
    } catch (error) {
      console.error("Error setting up event listeners:", error);
      throw error;
    }
  }

  /**
   * Executes the current bidding strategy.
   */
  // private async executeStrategy() {
  //   if (
  //     !this.activeWalletProvider ||
  //     !this.auctionState.isActive ||
  //     this.auctionState.currentDisplay >= this.auctionState.maxDisplays
  //   ) {
  //     return;
  //   }

  //   const currentPrice = await this.getCurrentPrice();
  //   if (currentPrice === BigInt(0)) {
  //     return;
  //   }
  //   const bidAmount =
  //     this.lastSuggestedPrice ||
  //     this.currentStrategy.calculateBid(currentPrice, this.auctionState).toString();

  //   // if (bidAmount > BigInt(0)) {
  //   //   const httpProvider = new JsonRpcProvider(process.env.HTTP_RPC_URL);
  //   //   const minimalAbi = [
  //   //     {
  //   //       inputs: [
  //   //         {
  //   //           internalType: "address",
  //   //           name: "owner",
  //   //           type: "address",
  //   //         },
  //   //       ],
  //   //       name: "getOwnedTokens",
  //   //       outputs: [
  //   //         {
  //   //           internalType: "uint256[]",
  //   //           name: "",
  //   //           type: "uint256[]",
  //   //         },
  //   //       ],
  //   //       stateMutability: "view",
  //   //       type: "function",
  //   //     },
  //   //   ];
  //   //   const placeholderNFT = new ethers.Contract(
  //   //     process.env.PLACEHOLDER_NFT_CONTRACT_ADDRESS!,
  //   //     minimalAbi,
  //   //     httpProvider,
  //   //   );
  //   //   const tokenIds = await placeholderNFT.getOwnedTokens(process.env.WALLET_ADDRESS!);

  //   //   const lastTokenId = tokenIds.length - 1;
  //   //   await this.placeBid(this.activeWalletProvider, {
  //   //     tokenId: lastTokenId.toString(), // You'll need to determine the correct tokenId
  //   //     bidAmount: formatUnits(bidAmount, 18),
  //   //   });
  //   // }
  // }

  /**
   * Gets the current price from the auction contract.
   *
   * @returns The current price as a bigint
   */
  private async getCurrentPrice(): Promise<bigint> {
    try {
      if (!this.httpProvider) {
        throw new Error("Http Provider not initialized getCurrentPrice()");
      }
      const isActive = await this.getAuctionState();
      if (!isActive) {
        console.log("Auction is not active getCurrentPrice");
        return BigInt(0);
      }
      const contract = new ethers.Contract(this.contractAddress, abi, this.httpProvider);
      const price = await contract.getCurrentPrice();
      this.auctionState.currentPrice = BigInt(price.toString());
      return BigInt(price.toString());
    } catch (error) {
      console.error("Error getting current price getCurrentPrice", error);
      return BigInt(0);
    }
  }

  /**
   * Retrieves the auction state from the smart contract and extracts the "isActive" boolean value.
   *
   * @returns {Promise<boolean>} A promise that resolves to the boolean indicating whether the auction is active.
   * @throws Will throw an error if the provider is not initialized or the contract call fails.
   */
  private async getAuctionState(): Promise<boolean> {
    try {
      if (!process.env.HTTP_RPC_URL) {
        throw new Error("HTTP_RPC_URL environment variable is not set");
      }

      if (!this.httpProvider) {
        throw new Error("Http Provider not initialized getAuctionState");
      }

      // Create a new contract instance using the ABI and provider
      // Changed from wssProvider to httpProvider since that's what we're checking above
      const contract = new ethers.Contract(this.contractAddress, abi, this.httpProvider);

      // Call the getAuctionState function and destructure only the isActive value
      // Using _ to ignore the first value (currentPrice) and omitting the third (timeRemaining)
      const [_, isActive] = await contract.getAuctionState();

      return isActive as boolean;
    } catch (error) {
      console.error("Error getting auction state:", error);
      return false;
    }
  }
  /**
   * Evaluates and updates the bidding strategy.
   *
   * @param wasSuccessful - Whether the last bid was successful
   */
  private async evaluateAndUpdateStrategy(wasSuccessful: boolean) {
    try {
      const currentPrice = await this.getCurrentPrice();

      // Update auction state with latest information
      this.auctionState = {
        ...this.auctionState,
        needsStrategyUpdate: true,
        lastStrategySuccess: wasSuccessful,
        currentPrice: currentPrice,
        strategyMetrics: {
          successRate: this.calculateSuccessRate(),
          averageBidPrice: this.calculateAverageBidPrice(),
          displayProgress: {
            acquired: this.auctionState.currentDisplay,
            remaining: this.auctionState.maxDisplays - this.auctionState.currentDisplay,
          },
        },
      };

      // Log comprehensive strategy evaluation info
      console.log("\n📊 Strategy Evaluation Triggered");
      console.log(`  Current Strategy: ${this.currentStrategy.name}`);
      console.log(`  Result: ${wasSuccessful ? "✅ Success" : "❌ Failed"}`);
      console.log(`  Current Price: ${ethers.formatUnits(currentPrice, 18)} USD`);
      console.log(
        `  Displays: ${this.auctionState.currentDisplay}/${this.auctionState.maxDisplays}`,
      );
      console.log(`  Success Rate: ${this.auctionState.strategyMetrics?.successRate}%`);
      console.log("-----------------------------\n");

      // The agent will handle strategy selection in its next cycle
      // through the select_strategy action
    } catch (error) {
      console.error("Error in strategy evaluation:", error);
      throw error;
    }
  }
  // Helper methods for strategy evaluation
  private calculateSuccessRate(): number {
    const total = this.auctionState.totalAuctions || 0;
    const wins = this.auctionState.currentDisplay;
    return total > 0 ? (wins / total) * 100 : 0;
  }

  private calculateAverageBidPrice(): bigint {
    if (!this.auctionState.bidHistory?.length) return BigInt(0);
    const sum = this.auctionState.bidHistory.reduce((acc, bid) => acc + bid, BigInt(0));
    return sum / BigInt(this.auctionState.bidHistory.length);
  }
}
export const placeholderActionProvider = () => new PlaceholderActionProvider();
