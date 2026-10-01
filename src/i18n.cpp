#include "i18n.h"

#include <windows.h>

#include <map>
#include <mutex>

#include "nlohmann/json.hpp"

namespace {

std::mutex g_mutex;
std::map<std::wstring, std::map<std::string, std::wstring>> g_dict;  // русская строка → язык → перевод
std::string g_lang = "ru";

std::wstring Widen(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

const char* kSupported[] = {"ru", "en", "de", "fr", "es", "pt", "it", "tr", "zh", "ja"};

}  // namespace

void I18nLoad(const std::string& jsonText) {
    // Формат: { "русская строка": { "en": "...", "de": "...", ... }, ... }
    nlohmann::json j = nlohmann::json::parse(jsonText, nullptr, false);
    if (j.is_discarded() || !j.is_object()) return;
    std::lock_guard<std::mutex> lock(g_mutex);
    g_dict.clear();
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (!it.value().is_object()) continue;
        auto& entry = g_dict[Widen(it.key())];
        for (auto tr = it.value().begin(); tr != it.value().end(); ++tr)
            if (tr.value().is_string()) entry[tr.key()] = Widen(tr.value().get<std::string>());
    }
}

std::string I18nSystemLanguage() {
    wchar_t name[LOCALE_NAME_MAX_LENGTH] = {};
    if (!LCIDToLocaleName(MAKELCID(GetUserDefaultUILanguage(), SORT_DEFAULT), name, LOCALE_NAME_MAX_LENGTH, 0))
        return "en";
    std::string code;
    for (int i = 0; i < 2 && name[i]; ++i) code += static_cast<char>(towlower(name[i]));
    return code;
}

void I18nSetLanguage(const std::string& lang) {
    std::string code = lang.empty() ? I18nSystemLanguage() : lang.substr(0, 2);
    bool supported = false;
    for (const char* s : kSupported) supported |= code == s;
    std::lock_guard<std::mutex> lock(g_mutex);
    g_lang = supported ? code : "en";
}

std::wstring Tr(const std::wstring& ru) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_lang == "ru") return ru;
    auto entry = g_dict.find(ru);
    if (entry == g_dict.end()) return ru;
    auto tr = entry->second.find(g_lang);
    return tr == entry->second.end() || tr->second.empty() ? ru : tr->second;
}

std::wstring TrF(const std::wstring& ru, const std::vector<std::wstring>& args) {
    std::wstring s = Tr(ru);
    for (size_t i = 0; i < args.size(); ++i) {
        const std::wstring token = L"{" + std::to_wstring(i) + L"}";
        for (size_t pos = s.find(token); pos != std::wstring::npos; pos = s.find(token, pos + args[i].size()))
            s.replace(pos, token.size(), args[i]);
    }
    return s;
}
