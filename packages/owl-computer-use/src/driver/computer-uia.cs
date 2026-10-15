// Isolated UIA provider calls. The parent owns a kill-on-close job and an 8s deadline.
// C#5 / inbox .NET Framework; the helper never reads or returns password values.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace OwlComputerUse
{
    public static class UiaHelper
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, string text, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
        private static extern IntPtr SendMessageTimeoutNative(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

        [STAThread]
        public static int Main()
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false);
            bool invoked = false;
            try
            {
                Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(Console.ReadLine());
                long hwnd = Convert.ToInt64(request["hwnd"]);
                if (!IsWindow(new IntPtr(hwnd))) { Write(Result("blocked", "target_gone")); return 0; }
                AutomationElement root = AutomationElement.FromHandle(new IntPtr(hwnd));
                if (Convert.ToString(request["action"]) == "observe")
                {
                    List<object> elements = new List<object>();
                    foreach (AutomationElement element in Walk(root))
                    {
                        try
                        {
                            if (element.Current.IsOffscreen || element.Current.BoundingRectangle.IsEmpty) continue;
                            elements.Add(Describe(element, elements.Count));
                            if (elements.Count >= 200) break;
                        }
                        catch (ElementNotAvailableException) { }
                    }
                    Write(new { elements = elements, available = true });
                    return 0;
                }
                uint pid;
                GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
                using (Process process = Process.GetProcessById((int)pid))
                {
                    if (pid != Convert.ToUInt32(request["pid"]) || process.StartTime.ToUniversalTime().Ticks != Convert.ToInt64(request["started"]))
                    { Write(Result("blocked", "target_replaced")); return 0; }
                }
                RECT bounds;
                Dictionary<string, object> expectedWindow = (Dictionary<string, object>)request["windowRect"];
                if (!PhysicalWindowRect(new IntPtr(hwnd), out bounds) || bounds.Left != Convert.ToInt32(expectedWindow["x"])
                    || bounds.Top != Convert.ToInt32(expectedWindow["y"]) || bounds.Right - bounds.Left != Convert.ToInt32(expectedWindow["width"])
                    || bounds.Bottom - bounds.Top != Convert.ToInt32(expectedWindow["height"]))
                { Write(Result("blocked", "geometry_changed")); return 0; }
                Dictionary<string, object> expected = (Dictionary<string, object>)request["element"];
                int[] runtimeId = ((System.Collections.IEnumerable)expected["runtimeId"]).Cast<object>().Select(Convert.ToInt32).ToArray();
                AutomationElement target = null;
                foreach (AutomationElement candidate in Walk(root))
                {
                    if (candidate.GetRuntimeId().SequenceEqual(runtimeId)) { target = candidate; break; }
                }
                if (target == null) { Write(Result("blocked", "stale_element")); return 0; }
                if (target.Current.IsPassword) { Write(Result("blocked", "password_control")); return 0; }
                if (target.Current.IsOffscreen || !target.Current.IsEnabled) { Write(Result("blocked", "element_unavailable")); return 0; }
                Dictionary<string, object> expectedRect = (Dictionary<string, object>)expected["rect"];
                System.Windows.Rect actualRect = target.Current.BoundingRectangle;
                if (Math.Abs(actualRect.X - Convert.ToDouble(expectedRect["x"])) > 1 || Math.Abs(actualRect.Y - Convert.ToDouble(expectedRect["y"])) > 1
                    || Math.Abs(actualRect.Width - Convert.ToDouble(expectedRect["width"])) > 1 || Math.Abs(actualRect.Height - Convert.ToDouble(expectedRect["height"])) > 1)
                { Write(Result("blocked", "element_geometry_changed")); return 0; }
                if (target.Current.Name != Convert.ToString(expected["name"]) || target.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") != Convert.ToString(expected["controlType"]))
                { Write(Result("blocked", "element_identity_changed")); return 0; }
                object pattern = null;
                string action = Convert.ToString(request["action"]);
                AutomationPattern required = action == "invoke" ? InvokePattern.Pattern : action == "set_value" ? ValuePattern.Pattern
                    : action == "select" ? SelectionItemPattern.Pattern : action == "toggle" ? TogglePattern.Pattern : action == "scroll" ? ScrollPattern.Pattern : null;
                if (required != null && !target.TryGetCurrentPattern(required, out pattern))
                { Write(Result("blocked", "unsupported_pattern")); return 0; }
                if (action == "set_value" && ((ValuePattern)pattern).Current.IsReadOnly)
                { Write(Result("blocked", "readonly_element")); return 0; }
                IntPtr nativeControl = IntPtr.Zero, notificationParent = IntPtr.Zero;
                int notificationId = 0;
                int nativeSelection = -1;
                if (action == "set_value") nativeControl = NativeChild(target, hwnd, pid, ControlType.Edit, "Edit", "WindowsForms10.EDIT.");
                else if (action == "invoke" || action == "toggle")
                {
                    nativeControl = action == "invoke" ? NativeChild(target, hwnd, pid, ControlType.Button, "Button", "WindowsForms10.BUTTON.")
                        : NativeChild(target, hwnd, pid, ControlType.CheckBox, "", "WindowsForms10.BUTTON.");
                    if (nativeControl != IntPtr.Zero)
                    {
                        int style = GetWindowLong(nativeControl, -16) & 0x000f;
                        bool allowedStyle = action == "invoke" ? style == 0 || style == 1 || style == 0x000b
                            : style == 2 || style == 3 || style == 5 || style == 6 || style == 0x000b;
                        notificationParent = GetParent(nativeControl);
                        uint parentPid;
                        GetWindowThreadProcessId(notificationParent, out parentPid);
                        notificationId = GetDlgCtrlID(nativeControl);
                        if (!allowedStyle || notificationParent == IntPtr.Zero || parentPid != pid || notificationId < 0
                            || (notificationParent != new IntPtr(hwnd) && !IsChild(new IntPtr(hwnd), notificationParent)))
                            nativeControl = IntPtr.Zero;
                        // WM_COMMAND carries the low word; WinForms can use a larger
                        // native child ID and reflects the exact validated lParam HWND.
                        notificationId &= 0xffff;
                    }
                }
                else if (action == "select" && target.Current.ControlType == ControlType.ListItem)
                {
                    AutomationElement list = TreeWalker.ControlViewWalker.GetParent(target);
                    if (list != null)
                    {
                        nativeControl = NativeChild(list, hwnd, pid, ControlType.List, "ListBox", "WindowsForms10.LISTBOX.");
                        if (nativeControl != IntPtr.Zero && (GetWindowLong(nativeControl, -16) & (0x0008 | 0x0800)) == 0)
                        {
                            IntPtr found, duplicate;
                            string name = Convert.ToString(expected["name"]);
                            if (SendMessageTimeout(nativeControl, 0x01a2, new IntPtr(-1), name, 0x0002 | 0x0020, 2000, out found) != IntPtr.Zero && found.ToInt64() >= 0
                                && SendMessageTimeout(nativeControl, 0x01a2, found, name, 0x0002 | 0x0020, 2000, out duplicate) != IntPtr.Zero && duplicate == found)
                            {
                                nativeSelection = found.ToInt32();
                                notificationParent = GetParent(nativeControl);
                                uint parentPid;
                                GetWindowThreadProcessId(notificationParent, out parentPid);
                                notificationId = GetDlgCtrlID(nativeControl);
                                if (notificationParent == IntPtr.Zero || parentPid != pid || notificationId < 0
                                    || (notificationParent != new IntPtr(hwnd) && !IsChild(new IntPtr(hwnd), notificationParent))) nativeSelection = -1;
                                notificationId &= 0xffff;
                            }
                        }
                    }
                }
                ToggleState beforeToggle = action == "toggle" ? ((TogglePattern)pattern).Current.ToggleState : ToggleState.Off;
                // All provider queries and native receiver selection precede this last
                // parent-hook handshake. The setter/notification follows the decision.
                Write(new { @event = "guard_ready" });
                if (Console.ReadLine() != "continue")
                { Write(Result("blocked", Convert.ToBoolean(request["exclusive"]) ? "user_intervened" : "target_intervened")); return 0; }
                if (action == "validate") Write(Result("confirmed", "element_validated"));
                else if (action == "focus_element")
                {
                    invoked = true;
                    target.SetFocus();
                    Write(Result(AutomationElement.FocusedElement.GetRuntimeId().SequenceEqual(runtimeId) ? "confirmed" : "unknown", "element_focus"));
                }
                else if (action == "invoke" && pattern != null)
                {
                    invoked = true;
                    if (nativeControl != IntPtr.Zero)
                    {
                        // Standard buttons notify their parent with BN_CLICKED. Select
                        // that equivalent route before invoking a provider that may focus
                        // the child window; never retry after a timeout or unknown result.
                        IntPtr clicked;
                        if (SendMessageTimeoutNative(notificationParent, 0x0111, new IntPtr(notificationId), nativeControl, 0x0002 | 0x0020, 2000, out clicked) == IntPtr.Zero)
                        { Write(Result("unknown", "invoke_outcome_unknown")); return 0; }
                    }
                    else ((InvokePattern)pattern).Invoke();
                    Write(Result("issued", "invoke_issued"));
                }
                else if (action == "set_value" && pattern != null)
                {
                    ValuePattern value = (ValuePattern)pattern;
                    string text = Convert.ToString(request["text"]);
                    invoked = true;
                    if (nativeControl != IntPtr.Zero)
                    {
                        // Select this backend before any setter runs. The standard Win32
                        // Edit message executes on its window thread and does not focus it.
                        // A timeout may follow a write, so it never triggers another setter.
                        IntPtr written;
                        if (SendMessageTimeout(nativeControl, 0x000c, IntPtr.Zero, text, 0x0002 | 0x0020, 2000, out written) == IntPtr.Zero)
                        { Write(Result("unknown", "value_outcome_unknown")); return 0; }
                    }
                    else value.SetValue(text);
                    Write(Result(value.Current.Value == text ? "confirmed" : "unknown", "value_readback"));
                }
                else if (action == "select" && pattern != null)
                {
                    invoked = true;
                    if (nativeSelection >= 0)
                    {
                        IntPtr selected;
                        if (SendMessageTimeoutNative(nativeControl, 0x0186, new IntPtr(nativeSelection), IntPtr.Zero, 0x0002 | 0x0020, 2000, out selected) == IntPtr.Zero || selected.ToInt64() < 0
                            || SendMessageTimeoutNative(notificationParent, 0x0111, new IntPtr(notificationId | 0x00010000), nativeControl, 0x0002 | 0x0020, 2000, out selected) == IntPtr.Zero)
                        { Write(Result("unknown", "selection_outcome_unknown")); return 0; }
                    }
                    else ((SelectionItemPattern)pattern).Select();
                    Write(Result(((SelectionItemPattern)pattern).Current.IsSelected ? "confirmed" : "unknown", "selection_readback"));
                }
                else if (action == "toggle" && pattern != null)
                {
                    TogglePattern toggle = (TogglePattern)pattern;
                    invoked = true;
                    if (nativeControl != IntPtr.Zero)
                    {
                        IntPtr toggled;
                        if (SendMessageTimeoutNative(nativeControl, 0x00f5, IntPtr.Zero, IntPtr.Zero, 0x0002 | 0x0020, 2000, out toggled) == IntPtr.Zero)
                        { Write(Result("unknown", "toggle_outcome_unknown")); return 0; }
                    }
                    else toggle.Toggle();
                    Write(Result(toggle.Current.ToggleState != beforeToggle ? "confirmed" : "unknown", "toggle_readback"));
                }
                else if (action == "scroll" && pattern != null)
                {
                    ScrollPattern scroll = (ScrollPattern)pattern;
                    int delta = Convert.ToInt32(request["delta"]);
                    bool horizontal = Convert.ToBoolean(request["horizontal"]);
                    if (delta == 0 || Math.Abs((long)delta) > 1200) { Write(Result("blocked", "invalid_scroll")); return 0; }
                    if (horizontal ? !scroll.Current.HorizontallyScrollable : !scroll.Current.VerticallyScrollable)
                    { Write(Result("blocked", "scroll_unavailable")); return 0; }
                    int count = Math.Max(1, (int)Math.Ceiling(Math.Abs((double)delta) / 120));
                    ScrollAmount amount = (horizontal ? delta > 0 : delta < 0) ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
                    invoked = true;
                    for (int i = 0; i < count; i++) scroll.Scroll(horizontal ? amount : ScrollAmount.NoAmount, horizontal ? ScrollAmount.NoAmount : amount);
                    Write(Result("issued", "scroll_issued"));
                }
                else Write(Result("blocked", "unsupported_pattern"));
                return 0;
            }
            catch (Exception error)
            {
                // Provider failures may follow a side effect; no automatic second executor.
                Write(new { status = invoked ? "unknown" : "blocked", code = invoked ? "uia_outcome_unknown" : "uia_unavailable", message = error.GetType().Name });
                return 0;
            }
        }

        private static IEnumerable<AutomationElement> Walk(AutomationElement root)
        {
            Queue<AutomationElement> pending = new Queue<AutomationElement>(); pending.Enqueue(root);
            Stopwatch deadline = Stopwatch.StartNew(); int visited = 0;
            while (pending.Count > 0 && visited++ < 600 && deadline.ElapsedMilliseconds < 3000)
            {
                AutomationElement item = pending.Dequeue(); yield return item;
                AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(item); int siblings = 0;
                while (child != null && siblings++ < 200 && pending.Count < 600)
                { pending.Enqueue(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            }
        }

        private static IntPtr NativeChild(AutomationElement target, long root, uint pid, ControlType expectedType, string nativeName, string managedPrefix)
        {
            IntPtr control = new IntPtr((long)(uint)target.Current.NativeWindowHandle);
            if (control == IntPtr.Zero || target.Current.ControlType != expectedType || !IsChild(new IntPtr(root), control)) return IntPtr.Zero;
            uint controlPid;
            GetWindowThreadProcessId(control, out controlPid);
            if (controlPid != pid) return IntPtr.Zero;
            RECT bounds;
            System.Windows.Rect expected = target.Current.BoundingRectangle;
            if (!PhysicalWindowRect(control, out bounds) || Math.Abs(bounds.Left - expected.X) > 1 || Math.Abs(bounds.Top - expected.Y) > 1
                || Math.Abs(bounds.Right - bounds.Left - expected.Width) > 1 || Math.Abs(bounds.Bottom - bounds.Top - expected.Height) > 1) return IntPtr.Zero;
            StringBuilder name = new StringBuilder(256);
            GetClassName(control, name, name.Capacity);
            string className = name.ToString();
            return className.Equals(nativeName, StringComparison.OrdinalIgnoreCase) || className.StartsWith(managedPrefix, StringComparison.OrdinalIgnoreCase) ? control : IntPtr.Zero;
        }

        private static bool PhysicalWindowRect(IntPtr hwnd, out RECT rect)
        {
            IntPtr previous = IntPtr.Zero;
            try { previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { }
            try { return GetWindowRect(hwnd, out rect); }
            finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }

        private static object Describe(AutomationElement element, int index)
        {
            System.Windows.Rect rect = element.Current.BoundingRectangle;
            bool password = element.Current.IsPassword;
            List<string> patterns = new List<string>(); object unused;
            if (!password)
            {
                if (element.TryGetCurrentPattern(InvokePattern.Pattern, out unused)) patterns.Add("Invoke");
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out unused)) patterns.Add("Value");
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out unused)) patterns.Add("SelectionItem");
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out unused)) patterns.Add("Toggle");
                if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out unused)) patterns.Add("Scroll");
            }
            Dictionary<string, object> row = new Dictionary<string, object> {
                { "id", "e" + (index + 1) }, { "name", password ? "[password]" : element.Current.Name },
                { "controlType", element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") },
                { "enabled", element.Current.IsEnabled }, { "password", password },
                { "rect", new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height } },
                { "patterns", patterns }, { "runtimeId", element.GetRuntimeId() }
            };
            // Reading an editable field's actual value lets text-only models verify a
            // previous issued/partial operation. Password providers are never queried.
            if (!password)
            {
                try
                {
                    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out unused))
                    {
                        ValuePattern value = (ValuePattern)unused;
                        string actual = value.Current.Value ?? "";
                        row["value"] = actual.Length > 4096 ? actual.Substring(0, 4096) : actual;
                        row["isReadOnly"] = value.Current.IsReadOnly;
                        if (actual.Length > 4096) row["truncated"] = true;
                    }
                }
                catch (Exception) { }
                try
                {
                    if (element.TryGetCurrentPattern(TextPattern.Pattern, out unused))
                    {
                        string actual = ((TextPattern)unused).DocumentRange.GetText(4097) ?? "";
                        row["text"] = actual.Length > 4096 ? actual.Substring(0, 4096) : actual;
                        if (actual.Length > 4096) row["truncated"] = true;
                    }
                }
                catch (Exception) { }
            }
            return row;
        }
        private static object Result(string status, string code) { return new { status = status, code = code }; }
        private static void Write(object result) { Console.WriteLine(Json.Serialize(result)); }
    }
}
