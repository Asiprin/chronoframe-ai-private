# ChronoFrame

> 本项目 fork 自
 [HoshinoSuzumi/chronoframe](https://github.com/HoshinoSuzumi/chronoframe)
 [cpt-kenvie](https://github.com/cpt-kenvie/chronoframe-private)
 在cpt-kenvie的基础上进行了功能增强和优化，供个人使用。
>
> **致谢**：感谢原作者 [HoshinoSuzumi](https://github.com/HoshinoSuzumi) 及所有贡献者。本项目基于原项目 **MIT 授权时期**的代码（`LICENSE` 保留原版权与 MIT 声明）；原项目后续版本已转为 AGPL-3.0-only，与本项目无代码合并关系。

丝滑的照片展示和管理应用，支持多种图片格式和大尺寸图片渲染。

## 🎯 新增功能

基于原项目，本版本新增了以下功能：

### AI 智能元数据（2026-10）

- **AI 视觉识别生成元数据** - 调用多模态视觉模型自动为照片生成标题、描述和标签
  - 接口可配置：任意 OpenAI 兼容服务（DeepSeek `deepseek-flash`、智谱 `glm-4v-flash`、通义 `qwen-vl-plus`、GPT-4o-mini 等）
  - 双触发：新照片上传后自动补全（可开关）；管理页单张/批量"AI 生成"为显式指令，重新生成并覆盖现有内容
  - 保护手填：自动场景只补空白字段（文件名派生的默认标题视为未填写），不触碰手动编辑的内容
  - **写回 EXIF**：生成结果写回原图 EXIF（Title/Description/Keywords），备份导出不丢元数据
  - 队列化执行：生成任务进入统一任务队列（类型"图片理解"），带重试与状态展示
- **提示词模板管理** - 管理员可在设置中添加、编辑、删除提示词模板，自由切换生成风格
  - 内置"默认模板"（配文风格：重意境联想而非复述画面，杜绝陈词滥调）
  - 标签字数限制：每个标签不超过 2 个汉字（英文 2 个单词）
  - 生成语言可选：简体中文 / 繁體中文 / English / 日本語
- **AI 服务测试按钮** - 设置页一键测试 API 连通性与模型图片识别能力（随机图形验证真视觉），并可一键加载可用模型列表供选择

### 备份与恢复（2026-10）

- **一键备份** - 导出数据库（设置、照片元数据、相册、账号）为 zip，可选打包本地照片文件
- **备份恢复** - 上传备份 zip 即可恢复；含 zip-slip 安全防护、清单校验、覆盖前自动保留旧库 `.bak`

### 照片管理增强（2026-10）

- **扫描导入** - 把照片直接拷贝进存储目录（支持子文件夹），后台一键批量入库并自动 AI 识别
  - 只处理静态图片：视频文件一概跳过（不单独入库），Live 播放不受影响（动态照片内嵌视频自动提取、苹果实况由管线自动配对同名视频）
  - 四重防重复：库内文件键、照片主键、队列任务记录、同名同大小指纹——连续扫描/清队列重扫均不重复
  - 只给缺少标题或描述的照片补全 AI 内容，已处理的不再排队
- **拍摄日期保护** - 从文件名识别日期（如 MVIMG_20260328_151530 → 2026-03-28）；重新处理/重扫保留原拍摄日期，不再变成处理当天
- **瀑布流时间排序** - 媒体管理工具栏一键切换时间升序/降序，管理表格与访客瀑布流联动排序
- **标签快捷编辑** - 筛选面板「编辑标签」模式下，标签角标 × 一键删除该标签；删除后所有标签页面**立即消失**，后台自动同步照片标签与 EXIF
- **删除更可靠** - 删除照片时存储文件删除失败不再静默，明确提示"N 个文件未能从存储删除，仍保留在存储中"
- **编辑弹窗滚动修复** - 小屏下元数据编辑弹窗可完整滚动查看

### 历史版本其他增强

- **高德地图支持** - 新增高德地图作为地图服务提供商，适配国内使用场景
- **相册管理增强**
  - 隐藏相册功能 - 支持将相册设置为隐藏状态
  - 照片分配相册 - 可以将照片批量分配到指定相册
  - 相册上传入口 - 在相册详情和列表页面增加直接上传入口
  - 相册预览优化 - 在相册中打开预览时，仅显示当前相册的照片
- **上传功能优化**
  - 上传组件支持选择目标相册
  - 上传前进行照片已存在检查，避免重复上传
  - 修复上传组件选择相册后无法正确添加照片的问题
- **视频支持**
  - 支持视频文件上传和管理
  - 鼠标悬停自动播放视频预览
  - 修复Live Photo分类bug
- **系统设置** - 新增系统设置页面，方便配置管理
- **国际化优化** - 完善中文翻译和i18n支持
- **照片管理优化** - 优化照片管理和设置页面的交互体验
- **全景照片支持**
  - 支持上传HDR/EXR格式全景照片
  - 支持为jpg格式的全景照片设置360全景照片属性

## ✨ 核心特性

- **在线管理照片** - 通过 Web 界面管理和浏览照片
- **AI 智能元数据** - 视觉模型自动生成照片标题/描述/标签，提示词模板可定制（DeepSeek/GLM-4V/Qwen-VL 等）
- **地图探索** - 在地图上浏览照片拍摄位置（支持 Mapbox/MapLibre/高德地图）
- **智能 EXIF 解析** - 自动提取拍摄时间、地理位置、相机参数等元数据
- **多格式支持** - 支持 JPEG、PNG、HEIC/HEIF、MOV(实况照片) 等格式
- **多存储后端** - 支持 S3 兼容存储、本地文件系统
- **技术栈** - Nuxt 4 + TypeScript + TailwindCSS + Drizzle ORM

## 🐳 快速部署

默认配置下，部署**不需要**传 `.env` 文件或任何环境变量；只要挂载数据目录即可。
原项目的.env配置已在设置中动态配置

### Docker（推荐）

```bash
docker run -d --name chronoframe --restart unless-stopped -p 3000:3000 -v ./data:/app/data kenv1e/chronoframe-private
```

访问 `http://localhost:3000` 即可使用。


### Docker Compose

新建 `docker-compose.yml`：

```yaml
services:
  chronoframe:
    image: kenv1e/chronoframe-private:latest
    container_name: chronoframe
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./data:/app/data
```

## 🛠️ 本地开发

```bash
# 安装依赖
pnpm install

# 数据库迁移
pnpm db:migrate

# 启动开发服务器
pnpm dev
```

## 🐳 打包镜像

```bash
# 打包镜像
docker build -t chronoframe:latest .

# 运行容器
docker run -d --name chronoframe --restart unless-stopped -p 3000:3000 -v ./data:/app/data chronoframe:latest
```

应用将在 `http://localhost:3000` 启动。

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

## 🙏 致谢

- 原项目：[HoshinoSuzumi/chronoframe](https://github.com/HoshinoSuzumi/chronoframe)
- 技术栈：[Nuxt](https://nuxt.com/) · [TailwindCSS](https://tailwindcss.com/) · [Drizzle ORM](https://orm.drizzle.team/)
