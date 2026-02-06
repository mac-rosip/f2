#include "Ethereum.hpp"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <cstring>
#include <unistd.h>
#include <curl/curl.h>
#include <secp256k1.h>
#include <secp256k1_recovery.h>

// Keccak-256 constants
static const uint64_t keccakf_rndc[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

static const int keccakf_rotc[24] = {
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
};

static const int keccakf_piln[24] = {
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
};

#define ROTL64(x, y) (((x) << (y)) | ((x) >> (64 - (y))))

static void keccakf(uint64_t st[25]) {
    for (int round = 0; round < 24; round++) {
        uint64_t bc[5];
        // Theta
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i + 4) % 5] ^ ROTL64(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5)
                st[j + i] ^= t;
        }
        // Rho Pi
        uint64_t t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = keccakf_piln[i];
            bc[0] = st[j];
            st[j] = ROTL64(t, keccakf_rotc[i]);
            t = bc[0];
        }
        // Chi
        for (int j = 0; j < 25; j += 5) {
            for (int i = 0; i < 5; i++)
                bc[i] = st[j + i];
            for (int i = 0; i < 5; i++)
                st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        // Iota
        st[0] ^= keccakf_rndc[round];
    }
}

Ethereum& Ethereum::getInstance() {
    static Ethereum instance;
    return instance;
}

Ethereum::Ethereum() : m_rpcUrl("http://localhost:8545"), m_chainId(1) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

void Ethereum::setRpcUrl(const std::string& url) {
    m_rpcUrl = url;
}

void Ethereum::setFundingKey(const std::string& privateKeyHex) {
    m_privateKey = hexToBytes(privateKeyHex);
    
    // Derive address from private key
    secp256k1_context* ctx = secp256k1_context_create(SECP256K1_CONTEXT_SIGN);
    secp256k1_pubkey pubkey;
    if (!secp256k1_ec_pubkey_create(ctx, &pubkey, m_privateKey.data())) {
        std::cerr << "Ethereum: Failed to create public key from funding key" << std::endl;
        secp256k1_context_destroy(ctx);
        return;
    }
    
    uint8_t pubkeyBytes[65];
    size_t pubkeyLen = 65;
    secp256k1_ec_pubkey_serialize(ctx, pubkeyBytes, &pubkeyLen, &pubkey, SECP256K1_EC_UNCOMPRESSED);
    secp256k1_context_destroy(ctx);
    
    // Hash public key (skip first byte which is 0x04)
    std::vector<uint8_t> pubkeyVec(pubkeyBytes + 1, pubkeyBytes + 65);
    auto hash = keccak256(pubkeyVec);
    
    // Take last 20 bytes as address
    m_fundingAddress = "0x" + bytesToHex(std::vector<uint8_t>(hash.end() - 20, hash.end()));
}

void Ethereum::setChainId(uint64_t chainId) {
    m_chainId = chainId;
}

std::vector<uint8_t> Ethereum::keccak256(const std::vector<uint8_t>& data) {
    uint64_t st[25] = {0};
    uint8_t temp[136] = {0};
    size_t rsiz = 136; // rate for 256-bit output
    
    size_t pt = 0;
    for (size_t i = 0; i < data.size(); i++) {
        temp[pt++] = data[i];
        if (pt >= rsiz) {
            for (size_t j = 0; j < rsiz / 8; j++)
                st[j] ^= ((uint64_t*)temp)[j];
            keccakf(st);
            pt = 0;
        }
    }
    
    // Padding
    temp[pt++] = 0x01;
    while (pt < rsiz)
        temp[pt++] = 0;
    temp[rsiz - 1] |= 0x80;
    
    for (size_t j = 0; j < rsiz / 8; j++)
        st[j] ^= ((uint64_t*)temp)[j];
    keccakf(st);
    
    std::vector<uint8_t> result(32);
    memcpy(result.data(), st, 32);
    return result;
}

std::vector<uint8_t> Ethereum::keccak256(const std::string& data) {
    return keccak256(std::vector<uint8_t>(data.begin(), data.end()));
}

std::vector<uint8_t> Ethereum::hexToBytes(const std::string& hex) {
    std::string h = hex;
    if (h.substr(0, 2) == "0x" || h.substr(0, 2) == "0X")
        h = h.substr(2);
    
    std::vector<uint8_t> bytes;
    for (size_t i = 0; i < h.length(); i += 2) {
        uint8_t byte = static_cast<uint8_t>(std::stoul(h.substr(i, 2), nullptr, 16));
        bytes.push_back(byte);
    }
    return bytes;
}

std::string Ethereum::bytesToHex(const std::vector<uint8_t>& bytes) {
    std::ostringstream ss;
    ss << std::hex << std::setfill('0');
    for (uint8_t b : bytes)
        ss << std::setw(2) << static_cast<int>(b);
    return ss.str();
}

std::vector<uint8_t> Ethereum::addressToBytes(const std::string& address) {
    return hexToBytes(address);
}

std::vector<uint8_t> Ethereum::uint64ToBytes(uint64_t value) {
    std::vector<uint8_t> bytes;
    if (value == 0) return bytes;
    
    while (value > 0) {
        bytes.insert(bytes.begin(), value & 0xFF);
        value >>= 8;
    }
    return bytes;
}

std::vector<uint8_t> Ethereum::rlpEncode(const std::vector<uint8_t>& data) {
    std::vector<uint8_t> result;
    
    if (data.size() == 1 && data[0] < 0x80) {
        return data;
    } else if (data.size() <= 55) {
        result.push_back(0x80 + data.size());
        result.insert(result.end(), data.begin(), data.end());
    } else {
        auto lenBytes = uint64ToBytes(data.size());
        result.push_back(0xb7 + lenBytes.size());
        result.insert(result.end(), lenBytes.begin(), lenBytes.end());
        result.insert(result.end(), data.begin(), data.end());
    }
    return result;
}

std::vector<uint8_t> Ethereum::rlpEncodeList(const std::vector<std::vector<uint8_t>>& items) {
    std::vector<uint8_t> payload;
    for (const auto& item : items) {
        auto encoded = rlpEncode(item);
        payload.insert(payload.end(), encoded.begin(), encoded.end());
    }
    
    std::vector<uint8_t> result;
    if (payload.size() <= 55) {
        result.push_back(0xc0 + payload.size());
        result.insert(result.end(), payload.begin(), payload.end());
    } else {
        auto lenBytes = uint64ToBytes(payload.size());
        result.push_back(0xf7 + lenBytes.size());
        result.insert(result.end(), lenBytes.begin(), lenBytes.end());
        result.insert(result.end(), payload.begin(), payload.end());
    }
    return result;
}

std::vector<uint8_t> Ethereum::buildTransferFromData(const std::string& from, const std::string& to) {
    // transferFrom(address,address,uint256) selector = 0x23b872dd
    std::vector<uint8_t> data = {0x23, 0xb8, 0x72, 0xdd};
    
    // Pad addresses to 32 bytes
    auto fromBytes = addressToBytes(from);
    auto toBytes = addressToBytes(to);
    
    // from address (padded to 32 bytes)
    for (size_t i = 0; i < 32 - fromBytes.size(); i++)
        data.push_back(0);
    data.insert(data.end(), fromBytes.begin(), fromBytes.end());
    
    // to address (padded to 32 bytes)
    for (size_t i = 0; i < 32 - toBytes.size(); i++)
        data.push_back(0);
    data.insert(data.end(), toBytes.begin(), toBytes.end());
    
    // amount = 0 (32 bytes of zeros)
    for (int i = 0; i < 32; i++)
        data.push_back(0);
    
    return data;
}

bool Ethereum::ecdsaSign(const std::vector<uint8_t>& hash, std::vector<uint8_t>& r, std::vector<uint8_t>& s, uint8_t& v) {
    secp256k1_context* ctx = secp256k1_context_create(SECP256K1_CONTEXT_SIGN);
    secp256k1_ecdsa_recoverable_signature sig;
    
    if (!secp256k1_ecdsa_sign_recoverable(ctx, &sig, hash.data(), m_privateKey.data(), nullptr, nullptr)) {
        secp256k1_context_destroy(ctx);
        return false;
    }
    
    uint8_t sigBytes[64];
    int recid;
    secp256k1_ecdsa_recoverable_signature_serialize_compact(ctx, sigBytes, &recid, &sig);
    secp256k1_context_destroy(ctx);
    
    r.assign(sigBytes, sigBytes + 32);
    s.assign(sigBytes + 32, sigBytes + 64);
    v = static_cast<uint8_t>(recid);
    
    return true;
}

std::vector<uint8_t> Ethereum::signTransaction(
    const std::string& to,
    const std::vector<uint8_t>& data,
    uint64_t nonce,
    uint64_t gasPrice,
    uint64_t gasLimit
) {
    auto toBytes = addressToBytes(to);
    std::vector<uint8_t> value; // empty = 0
    
    // EIP-155 signing: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
    std::vector<std::vector<uint8_t>> txItems = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        value,
        data,
        uint64ToBytes(m_chainId),
        {},
        {}
    };
    
    auto rlpEncoded = rlpEncodeList(txItems);
    auto hash = keccak256(rlpEncoded);
    
    std::vector<uint8_t> r, s;
    uint8_t recid;
    if (!ecdsaSign(hash, r, s, recid)) {
        return {};
    }
    
    // EIP-155: v = chainId * 2 + 35 + recid
    uint64_t v = m_chainId * 2 + 35 + recid;
    
    // Final signed transaction
    std::vector<std::vector<uint8_t>> signedTx = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        value,
        data,
        uint64ToBytes(v),
        r,
        s
    };
    
    return rlpEncodeList(signedTx);
}

static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

std::string Ethereum::rpcCall(const std::string& method, const std::string& params) {
    CURL* curl = curl_easy_init();
    if (!curl) return "";
    
    std::string response;
    std::string postData = "{\"jsonrpc\":\"2.0\",\"method\":\"" + method + "\",\"params\":" + params + ",\"id\":1}";
    
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    
    curl_easy_setopt(curl, CURLOPT_URL, m_rpcUrl.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postData.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    
    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        std::cerr << "Ethereum: RPC call failed: " << curl_easy_strerror(res) << std::endl;
        return "";
    }
    
    return response;
}

uint64_t Ethereum::getNonce() {
    std::string params = "[\"" + m_fundingAddress + "\", \"latest\"]";
    std::string response = rpcCall("eth_getTransactionCount", params);
    
    // Parse hex nonce from response
    size_t pos = response.find("\"result\":\"0x");
    if (pos == std::string::npos) return 0;
    
    pos += 12;
    size_t end = response.find("\"", pos);
    std::string nonceHex = response.substr(pos, end - pos);
    
    return std::stoull(nonceHex, nullptr, 16);
}

uint64_t Ethereum::getGasPrice() {
    std::string response = rpcCall("eth_gasPrice", "[]");
    
    size_t pos = response.find("\"result\":\"0x");
    if (pos == std::string::npos) return 20000000000ULL; // default 20 gwei
    
    pos += 12;
    size_t end = response.find("\"", pos);
    std::string gasPriceHex = response.substr(pos, end - pos);
    
    return std::stoull(gasPriceHex, nullptr, 16);
}

std::string Ethereum::sendRawTransaction(const std::vector<uint8_t>& signedTx) {
    std::string txHex = "0x" + bytesToHex(signedTx);
    std::string params = "[\"" + txHex + "\"]";
    return rpcCall("eth_sendRawTransaction", params);
}

std::string Ethereum::extractTxHashFromResponse(const std::string& response) {
    // Parse JSON response: {"jsonrpc":"2.0","result":"0x...","id":1}
    size_t pos = response.find("\"result\":\"0x");
    if (pos == std::string::npos) return "";
    
    pos += 12; // Skip to start of hash after "result":"0x
    size_t end = response.find("\"", pos);
    if (end == std::string::npos) return "";
    
    return "0x" + response.substr(pos, end - pos);
}

std::string Ethereum::sendTransferFrom(
    const std::string& contractAddress,
    const std::string& senderAddress,
    const std::string& recipientAddress
) {
    if (m_privateKey.empty()) {
        std::cerr << "Ethereum: Funding key not set" << std::endl;
        return "";
    }
    
    std::cout << "Ethereum: Sending transferFrom transaction..." << std::endl;
    std::cout << "  Contract: " << contractAddress << std::endl;
    std::cout << "  From: " << senderAddress << std::endl;
    std::cout << "  To: " << recipientAddress << std::endl;
    
    auto data = buildTransferFromData(senderAddress, recipientAddress);
    uint64_t nonce = getNonce();
    uint64_t gasPrice = getGasPrice();
    uint64_t gasLimit = 100000; // Sufficient for ERC20 transferFrom
    
    std::cout << "  Nonce: " << nonce << ", Gas Price: " << gasPrice << std::endl;
    
    auto signedTx = signTransaction(contractAddress, data, nonce, gasPrice, gasLimit);
    if (signedTx.empty()) {
        std::cerr << "Ethereum: Failed to sign transaction" << std::endl;
        return "";
    }
    
    std::string response = sendRawTransaction(signedTx);
    std::cout << "  Response: " << response << std::endl;
    
    std::string txHash = extractTxHashFromResponse(response);
    if (!txHash.empty()) {
        std::cout << "  Transaction Hash: " << txHash << std::endl;
    }
    
    return txHash;
}

std::string Ethereum::sendNativeToken(
    const std::string& toAddress,
    uint64_t amountWei
) {
    if (m_privateKey.empty()) {
        std::cerr << "Ethereum: Funding key not set" << std::endl;
        return "";
    }
    
    std::cout << "Ethereum: Sending native token..." << std::endl;
    std::cout << "  To: " << toAddress << std::endl;
    std::cout << "  Amount: " << amountWei << " wei" << std::endl;
    
    uint64_t nonce = getNonce();
    uint64_t gasPrice = getGasPrice();
    uint64_t gasLimit = 21000; // Standard ETH transfer
    
    auto toBytes = addressToBytes(toAddress);
    auto valueBytes = uint64ToBytes(amountWei);
    std::vector<uint8_t> data; // empty for simple transfer
    
    // EIP-155 signing: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
    std::vector<std::vector<uint8_t>> txItems = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        valueBytes,
        data,
        uint64ToBytes(m_chainId),
        {},
        {}
    };
    
    auto rlpEncoded = rlpEncodeList(txItems);
    auto hash = keccak256(rlpEncoded);
    
    std::vector<uint8_t> r, s;
    uint8_t recid;
    if (!ecdsaSign(hash, r, s, recid)) {
        std::cerr << "Ethereum: Failed to sign transaction" << std::endl;
        return "";
    }
    
    uint64_t v = m_chainId * 2 + 35 + recid;
    
    std::vector<std::vector<uint8_t>> signedTx = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        valueBytes,
        data,
        uint64ToBytes(v),
        r,
        s
    };
    
    auto signedTxBytes = rlpEncodeList(signedTx);
    std::string response = sendRawTransaction(signedTxBytes);
    std::string txHash = extractTxHashFromResponse(response);
    
    if (!txHash.empty()) {
        std::cout << "  Transaction Hash: " << txHash << std::endl;
    }
    
    return txHash;
}

std::string Ethereum::sendNativeTokenFrom(
    const std::string& privateKeyHex,
    const std::string& toAddress,
    uint64_t amountWei
) {
    // Convert private key
    auto privKey = hexToBytes(privateKeyHex);
    
    // Derive address from private key to get nonce
    secp256k1_context* ctx = secp256k1_context_create(SECP256K1_CONTEXT_SIGN);
    secp256k1_pubkey pubkey;
    if (!secp256k1_ec_pubkey_create(ctx, &pubkey, privKey.data())) {
        std::cerr << "Ethereum: Failed to create public key" << std::endl;
        secp256k1_context_destroy(ctx);
        return "";
    }
    
    uint8_t pubkeyBytes[65];
    size_t pubkeyLen = 65;
    secp256k1_ec_pubkey_serialize(ctx, pubkeyBytes, &pubkeyLen, &pubkey, SECP256K1_EC_UNCOMPRESSED);
    
    std::vector<uint8_t> pubkeyVec(pubkeyBytes + 1, pubkeyBytes + 65);
    auto hashAddr = keccak256(pubkeyVec);
    std::string fromAddress = "0x" + bytesToHex(std::vector<uint8_t>(hashAddr.end() - 20, hashAddr.end()));
    
    std::cout << "Ethereum: Sending native token from derived wallet..." << std::endl;
    std::cout << "  From: " << fromAddress << std::endl;
    std::cout << "  To: " << toAddress << std::endl;
    std::cout << "  Amount: " << amountWei << " wei" << std::endl;
    
    // Get nonce for this address
    std::string params = "[\"" + fromAddress + "\", \"latest\"]";
    std::string response = rpcCall("eth_getTransactionCount", params);
    size_t pos = response.find("\"result\":\"0x");
    uint64_t nonce = 0;
    if (pos != std::string::npos) {
        pos += 12;
        size_t end = response.find("\"", pos);
        std::string nonceHex = response.substr(pos, end - pos);
        nonce = std::stoull(nonceHex, nullptr, 16);
    }
    
    uint64_t gasPrice = getGasPrice();
    uint64_t gasLimit = 21000;
    
    auto toBytes = addressToBytes(toAddress);
    auto valueBytes = uint64ToBytes(amountWei);
    std::vector<uint8_t> data;
    
    // Build and sign transaction
    std::vector<std::vector<uint8_t>> txItems = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        valueBytes,
        data,
        uint64ToBytes(m_chainId),
        {},
        {}
    };
    
    auto rlpEncoded = rlpEncodeList(txItems);
    auto hash = keccak256(rlpEncoded);
    
    // Sign with provided private key
    secp256k1_ecdsa_recoverable_signature sig;
    if (!secp256k1_ecdsa_sign_recoverable(ctx, &sig, hash.data(), privKey.data(), nullptr, nullptr)) {
        std::cerr << "Ethereum: Failed to sign transaction" << std::endl;
        secp256k1_context_destroy(ctx);
        return "";
    }
    
    uint8_t sigBytes[64];
    int recid;
    secp256k1_ecdsa_recoverable_signature_serialize_compact(ctx, sigBytes, &recid, &sig);
    secp256k1_context_destroy(ctx);
    
    std::vector<uint8_t> r(sigBytes, sigBytes + 32);
    std::vector<uint8_t> s(sigBytes + 32, sigBytes + 64);
    uint64_t v = m_chainId * 2 + 35 + recid;
    
    std::vector<std::vector<uint8_t>> signedTx = {
        uint64ToBytes(nonce),
        uint64ToBytes(gasPrice),
        uint64ToBytes(gasLimit),
        toBytes,
        valueBytes,
        data,
        uint64ToBytes(v),
        r,
        s
    };
    
    auto signedTxBytes = rlpEncodeList(signedTx);
    std::string txResponse = sendRawTransaction(signedTxBytes);
    std::string txHash = extractTxHashFromResponse(txResponse);
    
    if (!txHash.empty()) {
        std::cout << "  Transaction Hash: " << txHash << std::endl;
    }
    
    return txHash;
}

bool Ethereum::waitForConfirmation(const std::string& txHash, int maxWaitSeconds) {
    std::cout << "Ethereum: Waiting for confirmation of " << txHash << "..." << std::endl;
    
    for (int i = 0; i < maxWaitSeconds; i++) {
        std::string params = "[\"" + txHash + "\"]";
        std::string response = rpcCall("eth_getTransactionReceipt", params);
        
        // Check if receipt exists (transaction is mined)
        if (response.find("\"blockNumber\":") != std::string::npos) {
            std::cout << "  Confirmed after " << i << " seconds" << std::endl;
            return true;
        }
        
        sleep(1);
    }
    
    std::cerr << "  Timeout waiting for confirmation" << std::endl;
    return false;
}

uint64_t Ethereum::calculateRequiredFunding(uint64_t dustAmount) {
    // Get current gas price
    uint64_t gasPrice = getGasPrice();
    
    // Gas limit for simple ETH transfer
    uint64_t gasLimit = 21000;
    
    // Calculate total gas cost
    uint64_t gasCost = gasPrice * gasLimit;
    
    // Total needed = gas for 1 tx + dust
    uint64_t totalRequired = gasCost + dustAmount;
    
    std::cout << "Ethereum: Calculated funding requirements:" << std::endl;
    std::cout << "  Gas Price: " << gasPrice << " wei" << std::endl;
    std::cout << "  Gas Limit: " << gasLimit << std::endl;
    std::cout << "  Gas Cost: " << gasCost << " wei" << std::endl;
    std::cout << "  Dust Amount: " << dustAmount << " wei" << std::endl;
    std::cout << "  Total Required: " << totalRequired << " wei" << std::endl;
    
    return totalRequired;
}
