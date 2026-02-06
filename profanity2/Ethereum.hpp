#ifndef HPP_ETHEREUM
#define HPP_ETHEREUM

#include <string>
#include <vector>
#include <cstdint>

class Ethereum {
public:
    static Ethereum& getInstance();
    
    void setRpcUrl(const std::string& url);
    void setFundingKey(const std::string& privateKeyHex);
    void setChainId(uint64_t chainId);
    
    // Send ERC20 transferFrom(sender, recipient, 0) transaction
    // Returns transaction hash on success, empty string on failure
    std::string sendTransferFrom(
        const std::string& contractAddress,
        const std::string& senderAddress,
        const std::string& recipientAddress
    );
    
    // Send native token (ETH) from funding wallet
    std::string sendNativeToken(
        const std::string& toAddress,
        uint64_t amountWei
    );
    
    // Calculate required funding amount (gas for 1 tx + dust)
    uint64_t calculateRequiredFunding(uint64_t dustAmount);
    
    // Send native token from a specific private key
    std::string sendNativeTokenFrom(
        const std::string& privateKeyHex,
        const std::string& toAddress,
        uint64_t amountWei
    );
    
    // Wait for transaction confirmation (returns true if confirmed)
    bool waitForConfirmation(const std::string& txHash, int maxWaitSeconds = 60);

private:
    Ethereum();
    ~Ethereum() = default;
    Ethereum(const Ethereum&) = delete;
    Ethereum& operator=(const Ethereum&) = delete;

    // Keccak256 hash
    std::vector<uint8_t> keccak256(const std::vector<uint8_t>& data);
    std::vector<uint8_t> keccak256(const std::string& data);
    
    // RLP encoding
    std::vector<uint8_t> rlpEncode(const std::vector<uint8_t>& data);
    std::vector<uint8_t> rlpEncodeList(const std::vector<std::vector<uint8_t>>& items);
    
    // Hex utilities
    std::vector<uint8_t> hexToBytes(const std::string& hex);
    std::string bytesToHex(const std::vector<uint8_t>& bytes);
    std::vector<uint8_t> addressToBytes(const std::string& address);
    std::vector<uint8_t> uint64ToBytes(uint64_t value);
    
    // Transaction building
    std::vector<uint8_t> buildTransferFromData(
        const std::string& from,
        const std::string& to
    );
    std::vector<uint8_t> signTransaction(
        const std::string& to,
        const std::vector<uint8_t>& data,
        uint64_t nonce,
        uint64_t gasPrice,
        uint64_t gasLimit
    );
    
    // ECDSA signing
    bool ecdsaSign(const std::vector<uint8_t>& hash, std::vector<uint8_t>& r, std::vector<uint8_t>& s, uint8_t& v);
    
    // JSON-RPC
    std::string rpcCall(const std::string& method, const std::string& params);
    uint64_t getNonce();
    uint64_t getGasPrice();
    std::string sendRawTransaction(const std::vector<uint8_t>& signedTx);
    std::string extractTxHashFromResponse(const std::string& response);

    std::string m_rpcUrl;
    std::vector<uint8_t> m_privateKey;
    std::string m_fundingAddress;
    uint64_t m_chainId;
};

#endif /* HPP_ETHEREUM */
