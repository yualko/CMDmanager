#pragma once

#include <string>
#include <vector>

// Локализация нативных окон (установщик, вопросы при закрытии) по тому же словарю, что и интерфейс: web/i18n.json.
// Ключ — исходная русская строка; подстановки записываются как {0}, {1}…

void I18nLoad(const std::string& jsonText);
void I18nSetLanguage(const std::string& lang);  // "ru", "en", … ; пусто — язык Windows
std::string I18nSystemLanguage();               // двухбуквенный код языка интерфейса Windows

std::wstring Tr(const std::wstring& ru);
std::wstring TrF(const std::wstring& ru, const std::vector<std::wstring>& args);
